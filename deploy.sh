#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

set -e

export AWS_REGION=us-east-1
export DOCKER_DEFAULT_PLATFORM=linux/amd64

# Set in case of Finch container builds
# export CDK_DOCKER=

cd edc/
./gradlew clean shadowJar

cd ../cdk/

npm run clean
npm install

cdk bootstrap
cdk deploy
