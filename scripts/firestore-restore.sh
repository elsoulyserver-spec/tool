#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# scripts/firestore-restore.sh
#
# Restore EasyTrac Firestore collections from a GCS backup.
# Validates the backup manifest before importing.
#
# Required env vars:
#   GCP_PROJECT   — GCP project id
#   GCS_PATH      — full GCS path to backup, e.g. gs://my-backups/firestore-backups/2026-06-28T02-00-00Z
#
# Optional:
#   RESTORE_COLLECTIONS  — comma-separated list of collections (default: all)
#   DRY_RUN=1            — print what would happen without importing
#   GOOGLE_CREDENTIALS   — path to service account key JSON
#
# Usage:
#   GCP_PROJECT=my-project GCS_PATH=gs://my-backups/... ./scripts/firestore-restore.sh
#
# WARNING: Firestore import MERGES documents — it does NOT delete existing docs.
#          To restore to a clean state, delete the collections first or use a
#          separate target project.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT="${GCP_PROJECT:?GCP_PROJECT is required}"
GCS_PATH="${GCS_PATH:?GCS_PATH is required (e.g. gs://bucket/path/timestamp)}"
DRY_RUN="${DRY_RUN:-0}"

echo "══════════════════════════════════════════"
echo "EasyTrac Firestore Restore"
echo "Project  : ${PROJECT}"
echo "Source   : ${GCS_PATH}"
echo "Dry run  : ${DRY_RUN}"
echo "══════════════════════════════════════════"

# Activate service account if credentials provided
if [[ -n "${GOOGLE_CREDENTIALS:-}" ]]; then
  gcloud auth activate-service-account --key-file="${GOOGLE_CREDENTIALS}"
fi

# ── Step 1: Validate backup manifest ─────────────────────────────────────────
MANIFEST_PATH="${GCS_PATH}/BACKUP_MANIFEST.json"
echo "Validating backup manifest: ${MANIFEST_PATH}"

if ! gsutil ls "${MANIFEST_PATH}" &>/dev/null; then
  echo "ERROR: BACKUP_MANIFEST.json not found at ${MANIFEST_PATH}"
  echo "This backup may be corrupted or the path is incorrect."
  exit 1
fi

MANIFEST_LOCAL="/tmp/easytrac-restore-manifest-$$.json"
gsutil cp "${MANIFEST_PATH}" "${MANIFEST_LOCAL}"

BACKUP_PROJECT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${MANIFEST_LOCAL}','utf8')).gcp_project || '')")
BACKUP_TIMESTAMP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${MANIFEST_LOCAL}','utf8')).backup_timestamp || '')")
BACKUP_COLLECTIONS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${MANIFEST_LOCAL}','utf8')).collections.join(','))")

echo "  Backup project   : ${BACKUP_PROJECT}"
echo "  Backup timestamp : ${BACKUP_TIMESTAMP}"
echo "  Collections      : ${BACKUP_COLLECTIONS}"

if [[ "${BACKUP_PROJECT}" != "${PROJECT}" ]]; then
  echo ""
  echo "WARNING: Backup was taken from project '${BACKUP_PROJECT}' but restoring to '${PROJECT}'."
  echo "Cross-project restore may cause permission issues. Continue? [y/N]"
  read -r CONFIRM
  if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Step 2: Validate backup path exists ──────────────────────────────────────
EXPORT_PATH="${GCS_PATH}/all_namespaces"
if ! gsutil ls "${EXPORT_PATH}/" &>/dev/null; then
  echo "ERROR: Export data not found at ${EXPORT_PATH}/"
  echo "The backup may be incomplete. Check: gsutil ls ${GCS_PATH}/"
  exit 1
fi
echo "Backup data verified at ${EXPORT_PATH}/"

# ── Step 3: Determine which collections to restore ───────────────────────────
if [[ -n "${RESTORE_COLLECTIONS:-}" ]]; then
  IFS=',' read -ra COLL_ARRAY <<< "${RESTORE_COLLECTIONS}"
else
  IFS=',' read -ra COLL_ARRAY <<< "${BACKUP_COLLECTIONS}"
fi

COLL_ARGS=""
for c in "${COLL_ARRAY[@]}"; do
  COLL_ARGS="${COLL_ARGS} --collection-ids=${c}"
done

echo ""
echo "Collections to restore: ${COLL_ARRAY[*]}"

# ── Step 4: Safety checkpoint ─────────────────────────────────────────────────
echo ""
echo "⚠️  WARNING: Firestore import MERGES data — existing documents are NOT deleted."
echo "   If you need a clean restore, delete collections manually first."
echo ""

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[DRY RUN] Would run:"
  echo "  gcloud firestore import ${GCS_PATH} --project=${PROJECT} ${COLL_ARGS}"
  echo ""
  echo "[DRY RUN] No data was imported."
  rm -f "${MANIFEST_LOCAL}"
  exit 0
fi

echo "Proceed with restore? [y/N]"
read -r PROCEED
if [[ "${PROCEED}" != "y" && "${PROCEED}" != "Y" ]]; then
  echo "Aborted."
  rm -f "${MANIFEST_LOCAL}"
  exit 0
fi

# ── Step 5: Run Firestore import ──────────────────────────────────────────────
echo "Starting Firestore import..."
gcloud firestore import "${GCS_PATH}" \
  --project="${PROJECT}" \
  ${COLL_ARGS}

echo ""
echo "Import submitted. Firestore import runs asynchronously."
echo "Check progress: gcloud firestore operations list --project=${PROJECT}"

# ── Step 6: Integrity check ───────────────────────────────────────────────────
echo ""
echo "Verifying key collections are accessible after import..."
sleep 10

# Spot-check: verify `clients` collection has documents
CLIENT_COUNT=$(gcloud firestore collections list --project="${PROJECT}" 2>/dev/null | grep -c "clients" || echo "0")
if [[ "${CLIENT_COUNT}" -gt 0 ]]; then
  echo "  ✓ clients collection exists in Firestore"
else
  echo "  ⚠ clients collection not yet visible (import may still be in progress)"
fi

rm -f "${MANIFEST_LOCAL}"

echo ""
echo "══════════════════════════════════════════"
echo "Restore initiated."
echo "  Source backup : ${GCS_PATH}"
echo "  Timestamp     : ${BACKUP_TIMESTAMP}"
echo "  To monitor    : gcloud firestore operations list --project=${PROJECT}"
echo ""
echo "Post-restore checklist:"
echo "  1. Verify client count in Firebase Console"
echo "  2. Test /api/admin/export returns expected data"
echo "  3. Verify a provisioning job can be created"
echo "  4. Verify MASTER_ENCRYPTION_KEY can decrypt a stored token"
echo "══════════════════════════════════════════"
