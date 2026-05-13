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

echo "Deploying to region: ${AWS_REGION} with profile: ${AWS_PROFILE}"

# Set in case of Finch container builds
# export CDK_DOCKER=

cd edc/
./gradlew clean shadowJar

cd ../cdk/

npm run clean
npm install

cdk bootstrap
cdk deploy
