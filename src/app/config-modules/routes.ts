import { YAMLMap, Document, Node, YAMLSeq, Scalar } from 'yaml';
import { ConfigBatchReader, BatchReaderResults } from '../config-batch-reader';
import { Config } from './device-configs';
import { DeviceModel } from './device-configs';
import { ConfigModuleInterface, YamlContext } from './config-module-interface';
import { Route, routeFromConfig } from '../route';
import { Waypoint } from '../waypoint';
import { YamlError } from '../yaml-sheet/yaml-sheet.component';
import { stringCompare } from '../util';

export type RouteDeviceConfig = {
  startAddress: number;
  numRoutes: number;
  numWaypointsPerRoute: number;
  bytesPerRoute: number;
};

export const ROUTE_DEVICE_CONFIGS: Map<DeviceModel, RouteDeviceConfig> =
  new Map([
    [
      'HX890',
      {
        startAddress: 0xc700,
        numRoutes: 20,
        numWaypointsPerRoute: 31,
        bytesPerRoute: 64
      }
    ],
    [
      'HX870',
      {
        startAddress: 0x5c00,
        numRoutes: 20,
        numWaypointsPerRoute: 16,
        bytesPerRoute: 32
      }
    ],
    [
      'HX891BT',
      {
        startAddress: 0xc700,
        numRoutes: 20,
        numWaypointsPerRoute: 31,
        bytesPerRoute: 64
      }
    ]
  ]);

export class RouteConfig implements ConfigModuleInterface {
  deviceConfig: RouteDeviceConfig | undefined;
  constructor(readonly deviceModel: DeviceModel) {
    this.deviceConfig = ROUTE_DEVICE_CONFIGS.get(deviceModel);
  }
  maybeVisitYamlNode(
    node: YAMLMap<unknown, unknown>,
    ctx: YamlContext
  ): boolean {
    const routesNode = node.get('routes');
    if (!routesNode) {
      return false;
    }
    if (!this.deviceConfig) {
      throw new YamlError(`Routes not supported on ${this.deviceModel}`, node);
    }
    const deviceConfig = this.deviceConfig;
    if (!(routesNode instanceof YAMLSeq)) {
      throw new YamlError('Unexpected routes node type', node);
    }
    const routesArray: Route[] = routesNode.items
      .map((routeNode) =>
        parseYamlRoute(
          routeNode,
          ctx.configOut,
          deviceConfig.numWaypointsPerRoute
        )
      )
      .sort((routeA: Route, routeB: Route) =>
        stringCompare(routeA.route.name, routeB.route.name)
      );
    const routeData = new Uint8Array(
      deviceConfig.bytesPerRoute * deviceConfig.numRoutes
    );
    routeData.fill(255);
    for (const [index, route] of routesArray.entries()) {
      route.fillConfig(
        routeData,
        deviceConfig.bytesPerRoute * index,
        deviceConfig.numWaypointsPerRoute,
        deviceConfig.bytesPerRoute
      );
    }
    ctx.configBatchWriter.prepareWrite(
      'routes',
      deviceConfig.startAddress,
      routeData
    );
    ctx.diagnosticsLog = {
      ...(ctx.diagnosticsLog || {}),
      routes: {
        used: routesArray.length,
        remaining: deviceConfig.numRoutes - routesArray.length
      }
    };
    return true;
  }
  addRangesToRead(configBatchReader: ConfigBatchReader): void {
    if (this.deviceConfig) {
      configBatchReader.addRange(
        'routes',
        this.deviceConfig.startAddress,
        this.deviceConfig.startAddress +
          this.deviceConfig.bytesPerRoute * this.deviceConfig.numRoutes
      );
    }
  }
  updateConfig(
    results: BatchReaderResults,
    config: Config,
    yaml: Document<Node, true>
  ): void {
    if (!this.deviceConfig) {
      return;
    }
    const routeData = results.get('routes');
    if (!routeData) {
      return;
    }
    if (!config.waypoints) {
      throw new Error('Waypoints must be parsed before routes.');
    }
    const routes: Route[] = [];
    for (let routeId = 0; routeId < this.deviceConfig.numRoutes; routeId++) {
      let offset = routeId * this.deviceConfig.bytesPerRoute;
      let route = routeFromConfig(
        routeData.subarray(offset, offset + this.deviceConfig.bytesPerRoute),
        this.deviceConfig.numWaypointsPerRoute
      );
      if (route) {
        routes.push(route);
      }
    }
    if (routes.length == 0) {
      return;
    }
    const waypoints = config.waypoints;
    const routeDirectory = routes.map((route) => ({
      [route.route.name]: rotateLeft(
        route.route.waypointIds.map((id) => lookupWaypoint(id, waypoints))
      )
    }));
    const routesNode = yaml.createNode({ routes: routeDirectory });
    routesNode.spaceBefore = true;
    yaml.add(routesNode);
  }
}

function lookupWaypoint(id: number, waypoints: Waypoint[]) {
  const wp = waypoints.find((wp) => wp.wp.id == id);
  if (wp) {
    return wp.wp.name;
  } else {
    return `? (${id})`;
  }
}

function rotateLeft<T>(array: Array<T>): Array<T> {
  return array.slice(1).concat(array.slice(0, 1));
}

function rotateRight<T>(array: Array<T>): Array<T> {
  return array.slice(-1).concat(array.slice(0, -1));
}

function parseYamlRoute(
  routeNode: any,
  configOut: Config,
  maxWaypoints: number
): any {
  if (
    !(
      routeNode instanceof YAMLMap &&
      routeNode.items.length == 1 &&
      routeNode.items[0].key instanceof Scalar &&
      routeNode.items[0].value instanceof YAMLSeq
    )
  ) {
    throw new YamlError('Unexpected route node type', routeNode);
  }
  if (!configOut.waypoints) {
    throw new YamlError('Waypoints must be declared before routes', routeNode);
  }
  let routeName = routeNode.items[0].key.value;
  if (routeName.length > 15) {
    throw new YamlError(`Route name too long "${routeName}"`, routeNode);
  }
  const waypointsSeq = routeNode.items[0].value;
  if (waypointsSeq.items.length == 0) {
    throw new YamlError(`No waypoints in route "${routeName}"`, routeNode);
  }
  if (waypointsSeq.items.length > maxWaypoints) {
    throw new YamlError(
      `Too many waypoints in route "${routeName}" (found ${waypointsSeq.items.length}, max is ${maxWaypoints})`,
      routeNode
    );
  }
  const waypointIds = [];
  for (const waypoint of waypointsSeq.items) {
    if (!(waypoint instanceof Scalar && typeof waypoint.value == 'string')) {
      throw new YamlError(`Unexpected route waypoint type`, waypoint);
    }
    const waypointName = waypoint.value;
    const waypoints = configOut.waypoints.filter(
      (wp) => wp.wp.name == waypointName
    );
    if (!waypoints || waypoints.length == 0) {
      throw new YamlError(`Waypoint ${waypointName} not found`, waypoint);
    }
    if (waypoints.length > 1) {
      throw new YamlError(`Multiple waypoints named ${waypointName}`, waypoint);
    }
    waypointIds.push(waypoints[0].wp.id);
  }

  return new Route({
    name: routeName,
    waypointIds: rotateRight(waypointIds)
  });
}
