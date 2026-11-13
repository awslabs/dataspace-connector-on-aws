#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -e
# A config path argument is relative to the caller; everything else to this repository.
if [ -n "${1:-}" ]; then
  CONFIG_PATH="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: ${1} is not a folder" >&2; exit 1; }
fi
cd "$(dirname "$0")"
CONFIG_PATH="${CONFIG_PATH:-$(pwd)/config}"

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

ask() { # ask <prompt> <default>; prints the answer
  local answer
  read -p "$1${2:+ [$2]}: " answer
  echo "${answer:-$2}"
}

SETUP=""
if [ -z "${1:-}" ] && [ ! -d "${CONFIG_PATH}" ]; then
  if [ ! -t 0 ]; then
    echo "Usage: ./deploy.sh [config-path]  (without a config path, run in a terminal to set up ./config)" >&2
    exit 1
  fi
  echo "Setting up ./config. These values are fixed once the pipeline exists."
  DEPLOYMENT_NAME=$(ask "Deployment name" "DataspaceConnector")
  APP_REPO=$(ask "App repository" "awslabs/dataspace-connector-on-aws")
  APP_VERSION=$(ask "App version" "$(git describe --tags --exact-match 2>/dev/null || git symbolic-ref --short HEAD 2>/dev/null || echo main)")
  CONFIG_SOURCE=$(ask "Config repository provider (codecommit or github)" "codecommit")
  if [ "${CONFIG_SOURCE}" = "github" ]; then
    CONFIG_REPO_NAME=$(ask "Config repository (owner/name)")
    CONNECTION_ARN=$(ask "CodeConnections connection ARN")
  fi
  # Built in a temporary folder and moved to ./config only once it is valid.
  SETUP="$(mktemp -d)/config"
  cp -R cdk/config-templates "${SETUP}"
  CONFIG_PATH="${SETUP}"
fi

echo "Deploying the pipeline to ${AWS_REGION} with profile ${AWS_PROFILE}"

cd cdk/
npm ci --ignore-scripts
npx tsc

if [ -n "${SETUP}" ]; then
  DEPLOYMENT_NAME="${DEPLOYMENT_NAME}" APP_REPO="${APP_REPO}" APP_VERSION="${APP_VERSION}" CONFIG_SOURCE="${CONFIG_SOURCE}" \
    CONFIG_REPO_NAME="${CONFIG_REPO_NAME:-}" CONNECTION_ARN="${CONNECTION_ARN:-}" CONFIG_PATH="${CONFIG_PATH}" \
    node -e "
      const e = process.env;
      const c = { appRepo: e.APP_REPO, appVersion: e.APP_VERSION, configSource: e.CONFIG_SOURCE,
        configRepoName: e.CONFIG_REPO_NAME || undefined, connectionArn: e.CONNECTION_ARN || undefined,
        deploymentName: e.DEPLOYMENT_NAME };
      const out = '# Reference: https://github.com/awslabs/dataspace-connector-on-aws#pipelineyaml\n\n' +
        require('js-yaml').dump(c);
      require('fs').writeFileSync(e.CONFIG_PATH + '/pipeline.yaml', out);"
fi
if [ ! -f "${CONFIG_PATH}/pipeline.yaml" ]; then
  echo "Error: pipeline.yaml not found in ${CONFIG_PATH}" >&2
  echo "Usage: ./deploy.sh [config-path]" >&2
  exit 1
fi

# Validates pipeline.yaml with the same loader the pipeline uses; prints name, source and connection.
SETTINGS=$(CONFIG_PATH="${CONFIG_PATH}" node -e "
  const c = require('./dist/config/config');
  try {
    const p = c.loadPipelineConfig(process.env.CONFIG_PATH);
    const name = c.resolveDeploymentName(p);
    c.validateDeploymentName(name);
    console.log(name, p.configSource ?? 'codecommit', p.connectionArn ?? '-');
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }")
read -r DEPLOYMENT_NAME CONFIG_SOURCE CONNECTION_ARN <<< "${SETTINGS}"

if [ -n "${SETUP}" ]; then
  mv "${SETUP}" "$(dirname "$(pwd)")/config"
  CONFIG_PATH="$(dirname "$(pwd)")/config"
fi

if [ "${CONFIG_SOURCE}" = "github" ]; then
  STATUS=$(aws codeconnections get-connection --connection-arn "${CONNECTION_ARN}" --query Connection.ConnectionStatus --output text)
  if [ "${STATUS}" != "AVAILABLE" ]; then
    echo "Error: connection ${CONNECTION_ARN} is ${STATUS}. Complete the GitHub handshake in the console first." >&2
    exit 1
  fi
fi

npx cdk bootstrap
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) CDK_DEFAULT_REGION="${AWS_REGION}" \
  npx cdk deploy "${DEPLOYMENT_NAME}PipelineStack" --context "config-path=${CONFIG_PATH}" --context "seed-path=${CONFIG_PATH}"

if [ "${CONFIG_SOURCE}" = "github" ]; then
  echo "Pipeline deployed. Push the contents of ${CONFIG_PATH} to your GitHub config repository to trigger deployments."
else
  echo "Pipeline deployed. Clone ${DEPLOYMENT_NAME}-config, edit it and push to trigger deployments."
fi
