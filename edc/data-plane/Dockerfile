# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

FROM --platform=linux/amd64 amazoncorretto:17-alpine

RUN addgroup -g 1001 edc && \
    adduser -D -u 1001 -G edc edc

WORKDIR /app
COPY build/libs/data-plane.jar edc-dataplane.jar

RUN chown -R edc:edc /app

USER edc
EXPOSE 8080

ENTRYPOINT ["java", \
    "-XX:+UseContainerSupport", \
    "-XX:MaxRAMPercentage=75.0", \
    "-XX:+ExitOnOutOfMemoryError", \
    "-Djava.security.egd=file:/dev/./urandom", \
    "-jar", "edc-dataplane.jar"]
