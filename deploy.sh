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
  echo "Usage: ./deploy.sh [config-path]" >&2
  exit 1
fi
CONFIG_PATH="$(cd "${CONFIG_PATH}" && pwd)"

echo "Deploying the pipeline to ${AWS_REGION} with profile ${AWS_PROFILE}, config ${CONFIG_PATH}"

cd cdk/
npm ci --ignore-scripts
npx tsc

DEPLOYMENT_NAME=$(node -e "const c = require('js-yaml').load(require('fs').readFileSync('${CONFIG_PATH}/pipeline.yaml', 'utf-8')); console.log(c.deploymentName ?? 'DataspaceConnector')")

npx cdk bootstrap
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) CDK_DEFAULT_REGION="${AWS_REGION}" \
  npx cdk deploy "${DEPLOYMENT_NAME}PipelineStack" --context "config-path=${CONFIG_PATH}"

echo "Pipeline deployed. Push changes to your config repository to trigger deployments."
