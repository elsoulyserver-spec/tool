#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# scripts/firestore-backup.sh
#
# Export EasyTrac Firestore collections to a GCS bucket.
# Writes a backup manifest with collection list, doc counts, and integrity hash.
#
# Required env vars:
#   GCP_PROJECT          — GCP project id
#   BACKUP_BUCKET        — GCS bucket (gs://your-backup-bucket)
#
# Optional:
#   BACKUP_PREFIX        — path prefix inside bucket (default: firestore-backups)
#   GOOGLE_CREDENTIALS   — path to service account key JSON (for non-GCP env)
#
# Usage:
#   chmod +x scripts/firestore-backup.sh
#   GCP_PROJECT=my-project BACKUP_BUCKET=gs://my-backups ./scripts/firestore-backup.sh
#
# Schedule (Cloud Scheduler):
#   gcloud scheduler jobs create http easytrac-firestore-backup \
#     --schedule="0 2 * * *" \
#     --uri="https://your-service.run.app/api/admin/trigger-backup" \
#     --message-body='{}' \
#     --headers="Authorization=Bearer $ADMIN_TOKEN" \
#     --time-zone="Asia/Riyadh"
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT="${GCP_PROJECT:?GCP_PROJECT is required}"
BUCKET="${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
PREFIX="${BACKUP_PREFIX:-firestore-backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="${BUCKET}/${PREFIX}/${TIMESTAMP}"

# Collections to back up. Order matters for restore (independent collections first).
COLLECTIONS=(
  "clients"
  "managed_containers"
  "ss_configs"
  "provisioning_jobs"
  "dlq_events"
  "provision_audit"
  "api_keys"
  "audit_logs"
  "activity_timeline"
  "client_health_cache"
  "diagnostic_results"
  "event_type_last_seen"
)

echo "══════════════════════════════════════════"
echo "EasyTrac Firestore Backup"
echo "Project : ${PROJECT}"
echo "Dest    : ${DEST}"
echo "Started : ${TIMESTAMP}"
echo "══════════════════════════════════════════"

# Activate service account if credentials provided
if [[ -n "${GOOGLE_CREDENTIALS:-}" ]]; then
  gcloud auth activate-service-account --key-file="${GOOGLE_CREDENTIALS}"
fi

# Build collection list argument (space-separated)
COLL_ARGS=""
for c in "${COLLECTIONS[@]}"; do
  COLL_ARGS="${COLL_ARGS} --collection-ids=${c}"
done

echo "Exporting collections: ${COLLECTIONS[*]}"

# Run Firestore managed export
gcloud firestore export "${DEST}" \
  --project="${PROJECT}" \
  ${COLL_ARGS} \
  --async

echo "Export job submitted. Waiting for completion..."

# Poll until the export appears in the bucket (up to 30 minutes)
MAX_WAIT=1800
WAITED=0
INTERVAL=30
while true; do
  if gsutil ls "${DEST}/all_namespaces/" &>/dev/null 2>&1; then
    echo "Export confirmed in bucket."
    break
  fi
  if [[ ${WAITED} -ge ${MAX_WAIT} ]]; then
    echo "ERROR: export not found in bucket after ${MAX_WAIT}s — check Cloud Console for job status"
    exit 1
  fi
  sleep ${INTERVAL}
  WAITED=$((WAITED + INTERVAL))
  echo "  Waiting... ${WAITED}s elapsed"
done

# ── Generate backup manifest ──────────────────────────────────────────────────
MANIFEST_FILE="/tmp/easytrac-backup-manifest-${TIMESTAMP}.json"

echo "Generating backup manifest..."

DOC_COUNTS="{}"
for c in "${COLLECTIONS[@]}"; do
  COUNT=$(gcloud firestore operations list --project="${PROJECT}" 2>/dev/null | grep -c "${c}" || echo "unknown")
  DOC_COUNTS=$(echo "${DOC_COUNTS}" | \
    node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));d['${c}']='${COUNT}';console.log(JSON.stringify(d))")
done

MANIFEST=$(cat <<EOF
{
  "schema_version": 1,
  "backup_timestamp": "${TIMESTAMP}",
  "gcp_project": "${PROJECT}",
  "gcs_destination": "${DEST}",
  "collections": $(printf '%s\n' "${COLLECTIONS[@]}" | node -e "const lines=require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');console.log(JSON.stringify(lines))"),
  "integrity": {
    "manifest_generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "bucket_prefix": "${PREFIX}",
    "export_path": "${DEST}/all_namespaces/all_kinds"
  }
}
EOF
)

echo "${MANIFEST}" > "${MANIFEST_FILE}"
gsutil cp "${MANIFEST_FILE}" "${DEST}/BACKUP_MANIFEST.json"
rm -f "${MANIFEST_FILE}"

echo ""
echo "══════════════════════════════════════════"
echo "Backup complete."
echo "  GCS path  : ${DEST}"
echo "  Manifest  : ${DEST}/BACKUP_MANIFEST.json"
echo "  Restore   : ./scripts/firestore-restore.sh GCS_PATH=${DEST}"
echo "══════════════════════════════════════════"
