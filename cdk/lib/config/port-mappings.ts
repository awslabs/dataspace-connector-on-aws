// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const CONTROL_PLANE_PORT_DEFAULT = 8181;
export const CONTROL_PLANE_PORT_MANAGEMENT = 8182;
export const CONTROL_PLANE_PORT_CONTROL = 9191;
export const CONTROL_PLANE_PORT_PROTOCOL = 8282;

export const DATA_PLANE_PORT_DEFAULT = 9181;
export const DATA_PLANE_PORT_PUBLIC = 8185;
export const DATA_PLANE_PORT_CONTROL = 9192;

export interface ControlPlanePortMapping {
  readonly control: number;
  readonly default: number;
  readonly management: number;
  readonly protocol: number;
}

export const CONTROL_PLANE_PORT_MAPPING_DEFAULT: ControlPlanePortMapping = {
  control: CONTROL_PLANE_PORT_CONTROL,
  default: CONTROL_PLANE_PORT_DEFAULT,
  management: CONTROL_PLANE_PORT_MANAGEMENT,
  protocol: CONTROL_PLANE_PORT_PROTOCOL,
};

export interface DataPlanePortMapping {
  readonly control: number;
  readonly default: number;
  readonly public: number;
}

export const DATA_PLANE_PORT_MAPPING_DEFAULT: DataPlanePortMapping = {
  control: DATA_PLANE_PORT_CONTROL,
  default: DATA_PLANE_PORT_DEFAULT,
  public: DATA_PLANE_PORT_PUBLIC,
};
