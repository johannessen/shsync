/// <reference types="w3c-web-serial" />

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ChunkReader } from './chunkreader';
import { ConfigSession } from './config-session';
import { ConfigProtocol, DatConfigProtocol } from './config-protocol';

export enum DeviceMode {
  Unknown = 0,
  CP = 1,
  NMEA = 2
}

export type DeviceConfig = {
  name: string;
  usbFilter: {
    usbVendorId: number;
    usbProductId: number;
  };
  waypointsStartAddress: number;
  waypointsNumber: number;
  routesStartAddress: number;
  routesNumber: number;
  numWaypointsPerRoute: number;
  routeBytes: number;
  individualMmsiNamesAddress: number;
  individualMmsiNumbersAddress: number;
  individualMmsiNum: number;
  groupMmsiNamesAddress: number;
  groupMmsiNumbersAddress: number;
  groupMmsiNum: number;
  datLength: number;
  datMagic: Uint8Array;
};

const DEVICE_CONFIGS: DeviceConfig[] = [
  {
    name: 'HX890',
    usbFilter: { usbVendorId: 9898, usbProductId: 30 },
    waypointsStartAddress: 0xd700,
    waypointsNumber: 250,
    routesStartAddress: 0xc700,
    routesNumber: 20,
    numWaypointsPerRoute: 31,
    routeBytes: 64,
    individualMmsiNamesAddress: 0x4500,
    individualMmsiNumbersAddress: 0x4200,
    individualMmsiNum: 100,
    groupMmsiNamesAddress: 0x5100,
    groupMmsiNumbersAddress: 0x5000,
    groupMmsiNum: 20,
    datLength: 0x10000,
    datMagic: new Uint8Array([0x03, 0x7a])
  },
  {
    name: 'HX870',
    usbFilter: { usbVendorId: 9898, usbProductId: 16 },
    waypointsStartAddress: 0x4300,
    waypointsNumber: 200,
    routesStartAddress: 0x5c00,
    routesNumber: 20,
    numWaypointsPerRoute: 16,
    routeBytes: 32,
    individualMmsiNamesAddress: 0x3730,
    individualMmsiNumbersAddress: 0x3500,
    individualMmsiNum: 100,
    groupMmsiNamesAddress: 0x3e80,
    groupMmsiNumbersAddress: 0x3e00,
    groupMmsiNum: 20,
    datLength: 0x8000,
    datMagic: new Uint8Array([0x03, 0x67])
  }
];

export type DeviceConnectionState =
  | 'disconnected'
  | 'usb-connecting'
  | 'usb-connected'
  | 'dat-connected';

@Injectable({
  providedIn: 'root'
})
export class DevicemgrService {
  readonly serial: Serial;
  private _connectionState = new BehaviorSubject<DeviceConnectionState>(
    'disconnected'
  );
  connectionState$ = this._connectionState.asObservable();
  port?: SerialPort;
  private _streamReader?: ReadableStreamDefaultReader;
  reader?: ChunkReader;
  writer?: WritableStreamDefaultWriter;
  readonly encoder: TextEncoder = new TextEncoder();
  readonly decoder: TextDecoder = new TextDecoder('utf-8');
  mode: DeviceMode = DeviceMode.Unknown;
  private _configProtocol: ConfigProtocol = new ConfigProtocol(this);
  readonly configSession: ConfigSession = new ConfigSession(
    this._configProtocol
  );

  constructor() {
    this.serial = navigator.serial;
  }

  getConnectionState(): DeviceConnectionState {
    return this._connectionState.getValue();
  }

  async connectUsb() {
    if (!this.serial) {
      throw new Error(
        "This browser doesn't support the Webserial API. Use Chrome, Edge, or Opera."
      );
    }
    if (this.getConnectionState() != 'disconnected') {
      throw new Error(
        `Cannot connect from state: ${this.getConnectionState()}`
      );
    }
    try {
      this._connectionState.next('usb-connecting');
      this.port = await this.serial.requestPort({
        filters: DEVICE_CONFIGS.map((conf) => conf.usbFilter)
      });
      const portInfo = this.port!.getInfo();
      const deviceConfig = DEVICE_CONFIGS.find(
        (conf) =>
          conf.usbFilter.usbProductId == portInfo.usbProductId &&
          conf.usbFilter.usbVendorId == portInfo.usbVendorId
      )!;
      console.log(`Found device ${deviceConfig.name}`);
      this.port.addEventListener('disconnect', (ev) => this.disconnect());
      await this.port.open({ baudRate: 9600 });
      this._streamReader = this.port?.readable?.getReader();
      this.reader = new ChunkReader(this._streamReader!);
      this.writer = this.port?.writable?.getWriter();
      await this.detectDeviceMode();
      if (this.mode != DeviceMode.CP) {
        throw new Error('Device must be in CP mode');
      }
      this._connectionState.next('usb-connected');
      this.configSession.reset(deviceConfig, this._configProtocol);
      console.log('Connected');
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  async disconnect() {
    if (this._connectionState.getValue() == 'dat-connected') {
      this._connectionState.next('disconnected');
      return;
    }
    try {
      await this.writer?.close();
      await this._streamReader?.cancel();
      this._streamReader?.releaseLock();
      this.writer?.releaseLock();
      await this.port?.close();
      await this.port?.forget();
      this.port = undefined;
      this._streamReader = undefined;
      this.reader = undefined;
      this.writer = undefined;
      this.mode = DeviceMode.Unknown;
      this.configSession.config.next({});
      console.log('Disconnected');
    } catch (e) {
      this.port = undefined;
      console.error(`Error while disconnecting: ${e}`);
    }
    this._connectionState.next('disconnected');
  }

  async write(s: string) {
    await this.writer?.write(this.encoder.encode(s));
  }

  async read(length: number): Promise<string> {
    let ans = await this.reader!.read(length);
    return ans;
  }

  async readline(): Promise<string> {
    let line = await this.reader!.readline();
    return line;
  }

  flushInput() {
    if (this.reader) {
      this.reader.flush();
    }
  }

  async detectDeviceMode() {
    await this.write('P?');
    const ans = await this.read(1);
    if (ans[0] == '@') {
      this.mode = DeviceMode.CP;
    } else if (ans[0] == 'P' || ans[0] == '$') {
      this.mode = DeviceMode.NMEA;
    }
    console.log(`Detected mode ${this.mode}`);
  }

  connectDat(datFile: Uint8Array) {
    if (this.getConnectionState() != 'disconnected') {
      throw new Error(
        `Cannot load DAT from state: ${this.getConnectionState()}`
      );
    }
    const deviceConfig = DEVICE_CONFIGS.find(
      (config) =>
        datFile.length == config.datLength &&
        config.datMagic.every((v, offset) => datFile[offset] == v)
    );
    if (!deviceConfig) {
      throw new Error(
        `Unknown DAT file format (length ${datFile.length}, magic ${datFile.subarray(0, 2)}`
      );
    }
    console.log(`Detected DAT file for ${deviceConfig.name}`);
    this.configSession.reset(deviceConfig, new DatConfigProtocol(datFile));
    this._connectionState.next('dat-connected');
  }
}
