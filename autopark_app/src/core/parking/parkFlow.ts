/**
 * App-side rules for the image -> slot -> confirmation -> autonomous parking
 * workflow. Pure functions so the safety rules are unit-tested.
 */

import { AnalysisReport } from '../vision/classifier';
import { SlotId } from '../vision/roi';
import { RoutePlan } from '../geometry/routePlanner';
import { RoverState, isAutonomous, isLatched } from '../esp32/protocol';

export type AppMode = 'manual' | 'autonomous' | 'idle';

export type SelectionCheck = { ok: true } | { ok: false; reason: string };

export interface SelectionOptions {
  /** User explicitly accepted that the photo does not match the ROI layout. */
  allowIncompatibleLayout?: boolean;
}

/**
 * Only an EMPTY slot can be a destination. OCCUPIED and UNCERTAIN are never
 * treated as available, and results from an image that does not fit the ROI
 * layout need an explicit override.
 */
export function canSelectSlot(report: AnalysisReport | null, slotId: SlotId, opts: SelectionOptions = {}): SelectionCheck {
  if (!report) return { ok: false, reason: 'Analyse a photo of the lot first.' };
  const slot = report.slots.find((s) => s.slot_id === slotId);
  if (!slot) return { ok: false, reason: `${slotId} is missing from the analysis.` };
  if (slot.status === 'OCCUPIED') return { ok: false, reason: `${slotId} is OCCUPIED.` };
  if (slot.status === 'UNCERTAIN') {
    return { ok: false, reason: `${slotId} is UNCERTAIN (confidence below the model's threshold). Retake the photo.` };
  }
  if (slot.status !== 'EMPTY') return { ok: false, reason: `${slotId} has an unknown status.` };
  if (!report.layout.compatible && !opts.allowIncompatibleLayout) {
    return {
      ok: false,
      reason: 'The photo does not match the ROI layout (see warnings). Re-take it from the calibrated viewpoint or confirm the override.',
    };
  }
  return { ok: true };
}

export function selectableSlots(report: AnalysisReport | null, opts: SelectionOptions = {}): SlotId[] {
  if (!report) return [];
  return report.slots.filter((s) => canSelectSlot(report, s.slot_id, opts).ok).map((s) => s.slot_id);
}

export interface StartContext {
  report: AnalysisReport | null;
  slotId: SlotId | null;
  plan: RoutePlan | null;
  linkLive: boolean;
  roverState: RoverState | null;
  estop: boolean;
  appMode: AppMode;
  requestInFlight: boolean;
  estimatesAcknowledged: boolean;
  slotConfirmedOnImage: boolean;
  /** User confirmed the rover sits at the configured start mark (dead reckoning starts there). */
  roverAtStartConfirmed: boolean;
  allowIncompatibleLayout?: boolean;
  analysisAgeMs?: number;
}

export const MAX_ANALYSIS_AGE_MS = 10 * 60 * 1000;

/** Every reason the Start button must stay disabled. Empty array = allowed. */
export function startBlockers(c: StartContext): string[] {
  const b: string[] = [];
  if (!c.slotId) b.push('Select a destination slot.');
  else {
    const sel = canSelectSlot(c.report, c.slotId, { allowIncompatibleLayout: c.allowIncompatibleLayout });
    if (!sel.ok) b.push(sel.reason);
  }
  if (c.analysisAgeMs !== undefined && c.analysisAgeMs > MAX_ANALYSIS_AGE_MS) {
    b.push('The analysis is more than 10 minutes old; analyse a fresh photo.');
  }
  if (!c.plan) b.push('No route plan.');
  else if (!c.plan.feasible) b.push(...c.plan.errors);
  if (!c.slotConfirmedOnImage) b.push('Confirm that the selected bay is empty in the photo.');
  if (!c.roverAtStartConfirmed) b.push('Place the rover at the start mark and confirm.');
  if (c.plan && c.plan.estimatesUsed.length > 0 && !c.estimatesAcknowledged) {
    b.push('Acknowledge that the route uses unmeasured (estimated) parameters.');
  }
  if (!c.linkLive) b.push('ESP32 is not connected (or telemetry is stale).');
  if (c.estop) b.push('Emergency stop is latched. Reset it on the rover first.');
  if (c.roverState && isLatched(c.roverState)) b.push(`Rover is in ${c.roverState}. Reset it first.`);
  if (c.roverState && isAutonomous(c.roverState)) b.push('An autonomous run is already in progress.');
  if (c.roverState === 'MANUAL' || c.roverState === 'CALIBRATING') b.push(`Rover is busy (${c.roverState}).`);
  if (c.appMode === 'manual') b.push('Leave manual mode first.');
  if (c.requestInFlight) b.push('A parking request is already being sent.');
  return b;
}

/**
 * Single-flight guard for commands that must not be sent twice (parking start,
 * calibration). The ESP32 additionally ignores a repeated request id.
 */
export class SingleFlight {
  private active: string | null = null;
  get busy(): boolean {
    return this.active !== null;
  }
  get current(): string | null {
    return this.active;
  }
  begin(id: string): boolean {
    if (this.active !== null) return false;
    this.active = id;
    return true;
  }
  end(id: string): void {
    if (this.active === id) this.active = null;
  }
}

/** Manual commands are refused while the rover runs autonomously or a stop is latched. */
export function manualBlockers(roverState: RoverState | null, estop: boolean, linkLive: boolean): string[] {
  const b: string[] = [];
  if (!linkLive) b.push('ESP32 not connected.');
  if (estop) b.push('Emergency stop latched - reset first.');
  if (roverState && isAutonomous(roverState)) b.push('Autonomous parking is running - abort it to take manual control.');
  if (roverState === 'CALIBRATING') b.push('Calibration run in progress.');
  if (roverState && isLatched(roverState)) b.push(`Rover is in ${roverState} - reset first.`);
  return b;
}
