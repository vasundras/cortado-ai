#!/usr/bin/env bash
# Cortado — Automated Cloud Run Deployment
# This script satisfies the hackathon's IaC/automated deployment requirement.
#
# Usage: ./scripts/deploy.sh PROJECT_ID GOOGLE_API_KEY [REGION]
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - A GCP project with billing enabled
#
# What this script does:
#   1. Enables required GCP APIs
#   2. Builds the container image via Cloud Build
#   3. Deploys to Cloud Run with HTTPS (phone-accessible, mic+camera work)
#   4. Sets the Gemini API key as an environment variable
#   5. Prints the live URL

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if [ $# -lt 2 ]; then
    echo "Usage: ./scripts/deploy.sh PROJECT_ID GOOGLE_API_KEY [REGION]"
    echo ""
    echo "  PROJECT_ID     Your GCP project ID"
    echo "  GOOGLE_API_KEY Your Gemini API key"
    echo "  REGION         Cloud Run region (default: us-central1)"
    exit 1
fi

PROJECT_ID="${1}"
GOOGLE_API_KEY="${2}"
REGION="${3:-us-central1}"
SERVICE_NAME="cortado"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Read Resend API key from .env if not already set
if [ -z "${RESEND_API_KEY:-}" ]; then
    RESEND_API_KEY=$(grep -s '^RESEND_API_KEY=' .env | cut -d'=' -f2 || echo "")
fi

echo "======================================"
echo "  ☕ Cortado — Cloud Run Deployment"
echo "======================================"
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "  Service:  ${SERVICE_NAME}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Enable required APIs
# ---------------------------------------------------------------------------
echo "[1/4] Enabling required GCP APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    generativelanguage.googleapis.com \
    --project="${PROJECT_ID}" \
    --quiet

# ---------------------------------------------------------------------------
# Step 2: Build container image via Cloud Build
# ---------------------------------------------------------------------------
echo "[2/4] Building container image via Cloud Build..."
gcloud builds submit \
    --project="${PROJECT_ID}" \
    --tag="${IMAGE_NAME}" \
    --quiet

# ---------------------------------------------------------------------------
# Step 3: Deploy to Cloud Run
# ---------------------------------------------------------------------------
echo "[3/4] Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${IMAGE_NAME}" \
    --platform=managed \
    --allow-unauthenticated \
    --memory=1Gi \
    --cpu=1 \
    --min-instances=0 \
    --max-instances=5 \
    --timeout=3600 \
    --session-affinity \
    --set-env-vars="GOOGLE_API_KEY=${GOOGLE_API_KEY}" \
    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID}" \
    --set-env-vars="CORTADO_AGENT_MODEL=gemini-2.5-flash-native-audio-preview-12-2025" \
    --set-env-vars="RESEND_API_KEY=${RESEND_API_KEY}" \
    --quiet

# ---------------------------------------------------------------------------
# Step 4: Get the service URL
# ---------------------------------------------------------------------------
echo "[4/4] Retrieving service URL..."
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --format="value(status.url)")

echo ""
echo "======================================"
echo "  ☕ Deployment complete!"
echo "======================================"
echo ""
echo "  URL: ${SERVICE_URL}"
echo ""
echo "  This is an HTTPS URL — open it on your phone"
echo "  for full mic + camera access."
echo ""
echo "  To update the API key later:"
echo "    gcloud run services update ${SERVICE_NAME} \\"
echo "      --set-env-vars=GOOGLE_API_KEY=new-key \\"
echo "      --region=${REGION} --project=${PROJECT_ID}"
echo ""
echo "  To view logs:"
echo "    gcloud run services logs read ${SERVICE_NAME} \\"
echo "      --region=${REGION} --project=${PROJECT_ID}"
