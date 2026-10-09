/**
 * When a wing or a battery bar is actually worth spending.
 *
 * DRS arms only on blue asphalt with a rival inside 6 squares. Open, it
 * allows gear 8 and a +2 climb below gear 6, then closes on any brake or
 * the first cell outside the zone. ERS spends one of four bars for a +2
 * step and halves that turn's fuel. A +1 on the wing does not need a bar.
 */
export type BoostPick = 'save' | 'drs' | 'ers' | 'both';

export interface BoostFacts {
  gear: number;
  nextGear: number;
  clearAhead: number;
  overspeed: boolean;
  gearLimited: boolean;
  drsArmed: boolean;
  drsActive: boolean;
  ersCharge: number;
  /** Chebyshev squares to the car ahead, or lead when nobody is. */
  gap: number | 'lead';
  /** Blue cells still under the car and ahead along travel. */
  blue: number;
  bendCells: number | null;
  fuel?: number;
  pit: boolean;
}

function stoppingDistance(gear: number): number {
  return (gear * (gear + 1)) / 2;
}

export function adviseBoost(facts: BoostFacts): BoostPick {
  if (facts.gearLimited || facts.pit || facts.overspeed) return 'save';
  if (facts.nextGear < facts.gear) return 'save';
  const bend = facts.bendCells;
  if (bend != null && bend <= stoppingDistance(facts.gear)) return 'save';

  const straight = bend == null || bend > 24 || bend > stoppingDistance(Math.min(8, facts.nextGear + 2));
  const runway = facts.clearAhead >= Math.max(4, facts.nextGear);
  const attack = facts.gap !== 'lead' && facts.gap <= 6;
  const armed = facts.drsArmed && !facts.drsActive;
  const wantDrs = armed && attack && straight && runway && facts.blue >= 3 && facts.nextGear >= facts.gear;

  const charge = facts.ersCharge;
  const saveLast = charge < 1.5 && bend != null && bend < 16;
  const exit = facts.gear <= 3 && facts.nextGear > facts.gear && straight && runway;
  const late = attack && facts.gap !== 'lead' && facts.gap <= 4 && facts.gear >= 5 && straight && runway;
  const fuelSave =
    facts.fuel !== undefined && facts.fuel <= 25 && facts.nextGear >= 5 && straight && runway;
  // Below gear 6 the open wing already climbs by 2, so a bar there is wasted.
  const wingCoversClimb = wantDrs && facts.gear < 6;
  const wantErs = charge >= 1 && !saveLast && (exit || late || fuelSave) && !wingCoversClimb;
  const wantBoth =
    wantDrs &&
    wantErs &&
    facts.gear >= 6 &&
    facts.gap !== 'lead' &&
    facts.gap <= 4 &&
    charge >= 2 &&
    facts.blue >= 4;

  if (wantBoth) return 'both';
  if (wantDrs) return 'drs';
  if (wantErs) return 'ers';
  return 'save';
}

/**
 * Easy opens both whenever a button lights up. Medium spends a bar it does
 * not need. Hard and pro play the advice, which is the actual challenge.
 */
export function playBoost(
  difficulty: 'easy' | 'medium' | 'hard' | 'pro',
  advice: BoostPick,
  facts: BoostFacts
): BoostPick {
  const canDrs = facts.drsArmed && !facts.drsActive;
  const canErs = facts.ersCharge >= 1;
  if (difficulty === 'easy') {
    if (facts.nextGear > facts.gear && (canDrs || canErs)) return 'both';
    return 'save';
  }
  if (difficulty === 'medium' && advice === 'drs' && canErs) return 'both';
  return advice;
}

export function boostCap(difficulty: 'easy' | 'medium' | 'hard' | 'pro'): number {
  if (difficulty === 'easy') return 3;
  if (difficulty === 'medium') return 5;
  return 8;
}
