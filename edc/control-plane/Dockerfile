# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

FROM public.ecr.aws/docker/library/amazoncorretto:25-alpine

RUN addgroup -g 1001 edc && \
    adduser -D -u 1001 -G edc edc

WORKDIR /app
COPY build/libs/control-plane.jar control-plane.jar

USER edc

ENTRYPOINT ["java", \
    "-XX:MaxRAMPercentage=75.0", \
    "-XX:+ExitOnOutOfMemoryError", \
    "-Djava.security.egd=file:/dev/./urandom", \
    "-jar", "control-plane.jar"]
