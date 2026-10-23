// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Container ports of the EDC control plane; `default` also serves the health check. */
export const CONTROL_PLANE_PORTS = {
  control: 9191,
  default: 8181,
  management: 8182,
  protocol: 8282,
} as const;

/** Container ports of the EDC data plane; `default` also serves the health check. */
export const DATA_PLANE_PORTS = {
  control: 9192,
  default: 9181,
  public: 8185,
} as const;
