#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -e

if [ -z "${AWS_REGION:-}" ]; then
  read -p "AWS Region [eu-central-1]: " input_region
  export AWS_REGION="${input_region:-eu-central-1}"
fi

if [ -z "${AWS_PROFILE:-}" ]; then
  read -p "AWS Profile: " AWS_PROFILE
  if [ -z "${AWS_PROFILE}" ]; then
    echo "Error: AWS_PROFILE is required." >&2
    exit 1
  fi
  export AWS_PROFILE
fi

CONFIG_PATH="${1:-./cdk/config-templates}"
if [ ! -f "${CONFIG_PATH}/pipeline.yaml" ]; then
  echo "Error: pipeline.yaml not found in ${CONFIG_PATH}" >&2
  echo "Usage: ./deploy-pipeline.sh [config-path]" >&2
  echo "       Default config path: ./cdk/config-templates" >&2
  exit 1
fi

echo "Deploying pipeline stack to region: ${AWS_REGION} with profile: ${AWS_PROFILE}"
echo "Config path: ${CONFIG_PATH}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cd cdk/

npm install --ignore-scripts
npx tsc

cdk bootstrap

CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}" CDK_DEFAULT_REGION="${AWS_REGION}" \
  npx cdk deploy DataspaceConnectorPipelineStack \
  --app 'node dist/pipeline-app.js' \
  --context "config-path=../${CONFIG_PATH}" \
  --require-approval never

echo ""
echo "✅ Pipeline deployed. Push changes to your config repository to trigger deployments."
