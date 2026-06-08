// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ControlPlanePortMapping {
  readonly control: number;
  readonly default: number;
  readonly management: number;
  readonly protocol: number;
}

export const CONTROL_PLANE_PORT_MAPPING_DEFAULT: ControlPlanePortMapping = {
  control: 9191,
  default: 8181,
  management: 8182,
  protocol: 8282,
};

export interface DataPlanePortMapping {
  readonly control: number;
  readonly default: number;
  readonly public: number;
}

export const DATA_PLANE_PORT_MAPPING_DEFAULT: DataPlanePortMapping = {
  control: 9192,
  default: 9181,
  public: 8185,
};
