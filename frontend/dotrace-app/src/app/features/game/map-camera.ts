/**
 * Map camera policy for the track sheet.
 * Leader follow and zoom are separate: zoom only changes magnification.
 * Panning (and the whole-sheet fit toggle) is what releases the follow.
 */

/** Magnification limits for the whole-sheet fit frame. */
export const MIN_MAP_ZOOM = 0.4;
export const MAX_MAP_ZOOM = 3;
/**
 * Safety bounds for leader-follow zoom. The canvas then clamps the picture
 * to the same min/max scale as a free zoom, so the +/- buttons can open the
 * sheet up without dropping the leader.
 */
const MIN_FOLLOW_ZOOM = 0.02;
const MAX_FOLLOW_ZOOM = 12;

export interface MapCamera {
  /** True after the user pans; the camera stops tracking. */
  manualCamera: boolean;
  /** Whole sheet, instead of the car or the leader. */
  fitMode: boolean;
  /** Multiplier on the automatic frame. 1 is the default framing. */
  zoomFactor: number;
}

export function clampMapZoom(zoom: number): number {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom));
}

/** Replay is tracking the leader (the Leader button is pressed). */
export function isFollowingLeader(followLeader: boolean, camera: MapCamera): boolean {
  return followLeader && !camera.manualCamera && !camera.fitMode;
}

/**
 * Button or pinch zoom.
 * `scaleManually` means the caller should zoom the current pixel scale.
 * Otherwise only `zoomFactor` changes and leader follow stays as it was.
 */
export function applyMapZoom(
  camera: MapCamera,
  followLeader: boolean,
  factor: number
): { camera: MapCamera; scaleManually: boolean } {
  if (isFollowingLeader(followLeader, camera)) {
    const zoomFactor = Math.min(
      MAX_FOLLOW_ZOOM,
      Math.max(MIN_FOLLOW_ZOOM, camera.zoomFactor * factor)
    );
    return { camera: { ...camera, zoomFactor }, scaleManually: false };
  }
  if (camera.fitMode) {
    return {
      camera: { ...camera, zoomFactor: clampMapZoom(camera.zoomFactor * factor) },
      scaleManually: false,
    };
  }
  if (!camera.manualCamera) {
    return {
      camera: { ...camera, manualCamera: true, fitMode: false },
      scaleManually: true,
    };
  }
  return { camera, scaleManually: true };
}

/** Turn leader follow back on. The viewer's zoom is left alone. */
export function focusLeaderCamera(camera: MapCamera): MapCamera {
  return { ...camera, manualCamera: false, fitMode: false };
}
