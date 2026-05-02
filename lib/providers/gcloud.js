// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/gcloud.js
// Google Cloud Run — GUIDED deployment provider.
//
// ⚠️  This provider does NOT make any GCP API calls.
// ⚠️  NO @google-cloud/run SDK — no GCP service account credentials stored.
// ⚠️  deployContainer() returns step-by-step instructions for the user to
//     run via gcloud CLI or Cloud Console.
//
// After the user deploys manually, they paste the Cloud Run URL back into the
// tool, which calls validateUrl() to confirm the container is reachable.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { BaseProvider } = require('./base');

class GoogleCloudProvider extends BaseProvider {
  // ── deployContainer ─────────────────────────────────────────────────────────
  // Returns guided instructions JSON — no API call made.
  // config: { configBody?, projectId?, region? }
  async deployContainer(config) {
    const cfg    = config || {};
    const region = cfg.region     || 'me-central1';
    const projId = cfg.projectId  || 'YOUR_PROJECT_ID';
    const cfgBody = cfg.configBody || 'PASTE_CONFIG_BODY_FROM_SGTM_ADMIN';

    const deployCmd = [
      'gcloud run deploy sgtm \\',
      '  --image=gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable \\',
      '  --platform=managed \\',
      '  --region=' + region + ' \\',
      '  --project=' + projId + ' \\',
      '  --allow-unauthenticated \\',
      '  --min-instances=1 \\',
      '  --set-env-vars=CONFIG_BODY=' + cfgBody,
    ].join('\n');

    return {
      mode:     'guided',
      provider: 'google-cloud-run',

      instructions: [
        {
          step:        1,
          title:       'تثبيت gcloud CLI',
          description: 'لو مش مثبّت عندك gcloud CLI، حمّله من الرابط:',
          url:         'https://cloud.google.com/sdk/docs/install',
          command:     null,
          consoleUrl:  null,
        },
        {
          step:        2,
          title:       'تفعيل Cloud Run API',
          description: 'فعّل الـ Cloud Run API في مشروعك:',
          command:     'gcloud services enable run.googleapis.com --project=' + projId,
          consoleUrl:  'https://console.cloud.google.com/apis/library/run.googleapis.com?project=' + projId,
        },
        {
          step:        3,
          title:       'الحصول على Container Config (CONFIG_BODY)',
          description: 'افتح Google Tag Manager → Server container → Admin → Install manually. انسخ الـ "Container config" string.',
          url:         'https://tagmanager.google.com',
          command:     null,
          consoleUrl:  null,
          inputField:  'configBody',
          placeholder: 'ZW50cnlwb2ludC5jb20uZ29vZ2xl...',
        },
        {
          step:        4,
          title:       'Deploy sGTM على Cloud Run',
          description: 'شغّل الأمر ده في terminal بعد ما تحط CONFIG_BODY الصح:',
          command:     deployCmd,
          consoleUrl:  'https://shell.cloud.google.com/?show=terminal',
          notes:       'الـ deploy هياخد ~3 دقائق. الناتج هيكون URL زي: https://sgtm-xxxx-xx.a.run.app',
        },
        {
          step:        5,
          title:       'الصق الـ Cloud Run URL',
          description: 'بعد ما الـ deploy ينتهي، انسخ الـ URL من الـ output وعود للأداة تعمل Confirm URL.',
          inputField:  'serverUrl',
          placeholder: 'https://sgtm-xxxx-xx.a.run.app',
          validation:  '^https://.+(run\\.app|your-custom-domain\\.com)',
        },
      ],

      cloudShellLink:  'https://shell.cloud.google.com/?show=terminal',
      estimatedTime:   '5-10 دقائق',
      cost:            '~$0-5/شهر للـ traffic المنخفض (ضمن الـ free tier)',
      docsLink:        'https://developers.google.com/tag-platform/tag-manager/server-side/cloud-run-setup-guide',
    };
  }

  // validateUrl, sendTestEvent, getContainerStatus → inherited from base
}

module.exports = { GoogleCloudProvider };
