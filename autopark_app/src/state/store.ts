/**
 * Single app store: configuration, ESP32 link + telemetry, map tracking,
 * classification result, slot selection and the parking request. Every screen
 * reads from here, so the dashboard, manual control, parking flow and the map
 * always show the same state.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_PARKING_CONFIG, ParkingConfig, mergeWithDefaults } from '../core/config/parkingConfig';
import { ROIConfig, ROIConfigJson, SlotId, parseROIConfig } from '../core/vision/roi';
import { AnalysisReport } from '../core/vision/classifier';
import { ConnectionState, INITIAL_CONNECTION, evaluateLink, onPollFailure, onPollSuccess } from '../core/esp32/connection';
import { RoverStatus } from '../core/esp32/protocol';
import { TrackState, attachPlan, initialTrack, resetTrack, updateTrack } from '../core/geometry/tracker';
import { RoutePlan } from '../core/geometry/routePlanner';
import { AppMode } from '../core/parking/parkFlow';
import { Esp32Client } from '../services/esp32Client';

import roiDefault from '../../assets/roi/roi_config.json';
import roiRealLot from '../../assets/roi/roi_real_lot_1.json';

export const ROI_PRESETS: Record<string, ROIConfigJson> = {
  roi_config: roiDefault as ROIConfigJson,
  roi_real_lot_1: roiRealLot as ROIConfigJson,
};

const CONFIG_KEY = 'autopark.config.v2';
const ROI_KEY = 'autopark.roi.v1';

export interface AnalysisState {
  report: AnalysisReport;
  imageUri: string;
  width: number;
  height: number;
  analyzedAt: number;
  roiLayout: string;
}

export interface ParkSession {
  rid: string;
  slotId: SlotId;
  plan: RoutePlan;
  phase: 'sending' | 'accepted' | 'rejected' | 'failed';
  message: string;
  sentAt: number;
}

export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'autopark.theme.v1';

interface AppState {
  hydrated: boolean;
  themePref: ThemePref;
  config: ParkingConfig;
  roiLayoutName: string; // preset key or 'custom'
  customRoi: ROIConfigJson | null;

  connection: ConnectionState;
  track: TrackState;
  appMode: AppMode;

  analysis: AnalysisState | null;
  selectedSlot: SlotId | null;
  allowIncompatibleLayout: boolean;
  slotConfirmedOnImage: boolean;
  estimatesAcknowledged: boolean;
  roverAtStartConfirmed: boolean;
  park: ParkSession | null;

  // actions
  hydrate: () => Promise<void>;
  setThemePref: (p: ThemePref) => void;
  setConfig: (updater: (c: ParkingConfig) => ParkingConfig) => void;
  resetConfig: () => void;
  setRoiLayout: (name: string, custom?: ROIConfigJson | null) => void;
  roiConfig: () => ROIConfig;
  client: () => Esp32Client;

  pollSucceeded: (s: RoverStatus, now: number) => void;
  pollFailed: (error: string, now: number) => void;
  tickLink: (now: number) => void;

  resetPosition: () => void;
  setAppMode: (m: AppMode) => void;

  setAnalysis: (a: AnalysisState | null) => void;
  selectSlot: (s: SlotId | null) => void;
  setFlag: (k: 'allowIncompatibleLayout' | 'slotConfirmedOnImage' | 'estimatesAcknowledged' | 'roverAtStartConfirmed', v: boolean) => void;
  beginPark: (session: ParkSession) => void;
  updatePark: (patch: Partial<ParkSession>) => void;
  clearPark: () => void;
}

let clientCache: { host: string; timeout: number; client: Esp32Client } | null = null;

export const useApp = create<AppState>()((set, get) => ({
  hydrated: false,
  themePref: 'system',
  config: mergeWithDefaults(null),
  roiLayoutName: 'roi_config',
  customRoi: null,

  connection: INITIAL_CONNECTION,
  track: initialTrack(DEFAULT_PARKING_CONFIG),
  appMode: 'idle',

  analysis: null,
  selectedSlot: null,
  allowIncompatibleLayout: false,
  slotConfirmedOnImage: false,
  estimatesAcknowledged: false,
  roverAtStartConfirmed: false,
  park: null,

  hydrate: async () => {
    try {
      const [c, r, th] = await Promise.all([AsyncStorage.getItem(CONFIG_KEY), AsyncStorage.getItem(ROI_KEY), AsyncStorage.getItem(THEME_KEY)]);
      const config = mergeWithDefaults(c ? JSON.parse(c) : null);
      const roi = r ? (JSON.parse(r) as { name: string; custom: ROIConfigJson | null }) : null;
      set({
        config,
        track: initialTrack(config),
        roiLayoutName: roi?.name ?? 'roi_config',
        customRoi: roi?.custom ?? null,
        themePref: th === 'light' || th === 'dark' ? th : 'system',
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  setThemePref: (p) => {
    set({ themePref: p });
    AsyncStorage.setItem(THEME_KEY, p).catch(() => undefined);
  },

  setConfig: (updater) => {
    const config = updater(get().config);
    set({ config, estimatesAcknowledged: false });
    AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config)).catch(() => undefined);
  },

  resetConfig: () => {
    const config = mergeWithDefaults(null);
    set({ config, track: initialTrack(config), estimatesAcknowledged: false });
    AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config)).catch(() => undefined);
  },

  setRoiLayout: (name, custom = null) => {
    set({ roiLayoutName: name, customRoi: custom ?? get().customRoi, analysis: null, selectedSlot: null });
    AsyncStorage.setItem(ROI_KEY, JSON.stringify({ name, custom: custom ?? get().customRoi })).catch(() => undefined);
  },

  roiConfig: () => {
    const { roiLayoutName, customRoi } = get();
    const json = roiLayoutName === 'custom' && customRoi ? customRoi : ROI_PRESETS[roiLayoutName] ?? ROI_PRESETS.roi_config;
    return parseROIConfig(json);
  },

  client: () => {
    const { host, requestTimeoutMs } = get().config.esp32;
    if (!clientCache || clientCache.host !== host || clientCache.timeout !== requestTimeoutMs) {
      clientCache = { host, timeout: requestTimeoutMs, client: Esp32Client.forHost(host, requestTimeoutMs) };
    }
    return clientCache.client;
  },

  pollSucceeded: (s, now) => {
    const { connection, track, config } = get();
    set({ connection: onPollSuccess(connection, s, now), track: updateTrack(track, s, config) });
  },
  pollFailed: (error, now) => set({ connection: onPollFailure(get().connection, error, now) }),
  tickLink: (now) => {
    const c = get().connection;
    const next = evaluateLink(c, now, get().config.esp32.staleAfterMs);
    if (next !== c) set({ connection: next });
  },

  resetPosition: () => set({ track: resetTrack(get().track, get().config) }),
  setAppMode: (m) => set({ appMode: m }),

  setAnalysis: (a) =>
    set({ analysis: a, selectedSlot: null, slotConfirmedOnImage: false, allowIncompatibleLayout: false, park: get().park }),
  selectSlot: (s) => set({ selectedSlot: s, slotConfirmedOnImage: false }),
  setFlag: (k, v) => set({ [k]: v } as Pick<AppState, typeof k>),

  beginPark: (session) => set({ park: session, track: attachPlan(get().track, session.plan, session.rid) }),
  updatePark: (patch) => {
    const p = get().park;
    if (p) set({ park: { ...p, ...patch } });
  },
  clearPark: () => set({ park: null, roverAtStartConfirmed: false }),
}));
