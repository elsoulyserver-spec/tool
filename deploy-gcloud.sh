#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Easy Track — Google Cloud Run — First-Time Deploy Script
# ══════════════════════════════════════════════════════════════════════════════
# Run once:  bash deploy-gcloud.sh
# After that, use Cloud Build trigger or run again to redeploy.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${CYAN}[→]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Easy Track — Google Cloud Run Deploy   ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Prerequisites check ───────────────────────────────────────────────────────
command -v gcloud &>/dev/null || error "gcloud CLI غير مثبت. حمّله من: https://cloud.google.com/sdk/docs/install"

# ── Config ───────────────────────────────────────────────────────────────────
read -rp "$(echo -e "${CYAN}اسم الـ GCP Project ID:${NC} ")" PROJECT_ID
read -rp "$(echo -e "${CYAN}اسم الـ Service (اضغط Enter لـ 'easytrac'):${NC} ")" SERVICE_NAME
SERVICE_NAME="${SERVICE_NAME:-easytrac}"

REGION="me-central1"   # Qatar / MENA region — أقرب region للسعودية
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/easytrac/${SERVICE_NAME}"

echo ""
info "Project: ${PROJECT_ID}"
info "Service: ${SERVICE_NAME}"
info "Region:  ${REGION} (Middle East — Qatar)"
info "Image:   ${IMAGE}"
echo ""

# ── Login & set project ───────────────────────────────────────────────────────
info "تسجيل الدخول لـ Google Cloud..."
gcloud auth login --quiet
gcloud config set project "${PROJECT_ID}"

# ── Enable required APIs ──────────────────────────────────────────────────────
info "تفعيل الـ APIs المطلوبة..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --quiet
success "APIs مفعّلة"

# ── Create Artifact Registry repo ─────────────────────────────────────────────
info "إنشاء Artifact Registry repository..."
gcloud artifacts repositories create easytrac \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Easy Track Docker images" \
  --quiet 2>/dev/null && success "Repository اتعمل" || warn "Repository موجود بالفعل"

# ── Configure Docker auth ──────────────────────────────────────────────────────
info "إعداد Docker auth..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
success "Docker auth جاهز"

# ── Secrets setup ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}══ إعداد الـ Secrets ══${NC}"
echo ""

create_secret() {
  local SECRET_NAME="$1"
  local PROMPT="$2"
  local IS_FILE="${3:-false}"

  if gcloud secrets describe "${SECRET_NAME}" --quiet &>/dev/null; then
    warn "Secret '${SECRET_NAME}' موجود — هتخطيه. لتحديثه: gcloud secrets versions add ${SECRET_NAME} --data-file=-"
  else
    if [ "${IS_FILE}" = "true" ]; then
      read -rp "$(echo -e "${CYAN}${PROMPT} (مسار الملف):${NC} ")" SECRET_PATH
      [ -f "${SECRET_PATH}" ] || error "الملف مش موجود: ${SECRET_PATH}"
      gcloud secrets create "${SECRET_NAME}" --data-file="${SECRET_PATH}" --quiet
    else
      read -rsp "$(echo -e "${CYAN}${PROMPT}:${NC} ")" SECRET_VALUE
      echo ""
      echo -n "${SECRET_VALUE}" | gcloud secrets create "${SECRET_NAME}" --data-file=- --quiet
    fi
    success "Secret '${SECRET_NAME}' اتحفظ"
  fi
}

create_secret "easytrac-admin-token"  "ADMIN_TOKEN (كلمة سر الـ Admin Panel)"
create_secret "easytrac-firebase-key" "مسار ملف Firebase Service Account JSON" "true"
create_secret "easytrac-gtm-key"      "مسار ملف GTM Service Account JSON" "true"

# ── Grant Cloud Run access to secrets ─────────────────────────────────────────
info "منح Cloud Run صلاحية قراءة الـ Secrets..."
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
CLOUD_RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in easytrac-admin-token easytrac-firebase-key easytrac-gtm-key; do
  gcloud secrets add-iam-policy-binding "${SECRET}" \
    --member="serviceAccount:${CLOUD_RUN_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null || true
done
success "Secrets permissions جاهزة"

# ── Build & deploy ─────────────────────────────────────────────────────────────
echo ""
info "بناء ورفع الـ Docker image..."
gcloud builds submit \
  --tag="${IMAGE}:latest" \
  --suppress-logs \
  .
success "Image اتبنى واترفع"

echo ""
info "Deploying إلى Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}:latest" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --concurrency=80 \
  --timeout=60 \
  --set-secrets="ADMIN_TOKEN=easytrac-admin-token:latest,FIREBASE_SA_KEY_JSON=easytrac-firebase-key:latest,GTM_SA_KEY_JSON=easytrac-gtm-key:latest" \
  --set-env-vars="NODE_ENV=production" \
  --quiet

# ── Get URL ───────────────────────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --format='value(status.url)')

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           ✅ Deploy اتعمل بنجاح!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
success "التول شغّالة على: ${SERVICE_URL}"
echo ""
echo -e "${YELLOW}الخطوة الجاية — ربط Domain مخصص (اختياري):${NC}"
echo "  gcloud run domain-mappings create --service=${SERVICE_NAME} --domain=tool.easytrac.io --region=${REGION}"
echo ""
echo -e "${YELLOW}لإعداد Auto-deploy عند كل git push:${NC}"
echo "  شغّل:  gcloud builds triggers create github --repo-owner=<user> --repo-name=easytrac.io --branch-pattern='^main$' --build-config=cloudbuild.yaml"
echo ""
