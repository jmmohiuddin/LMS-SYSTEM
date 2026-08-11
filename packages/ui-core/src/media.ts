/**
 * F-902. Preparing a photo or a spoken answer for submission.
 *
 * The constraint that shapes all of this: a student on a 2GB Android Go
 * phone, on 3G, submitting from home. A 4 MB camera JPEG will not complete
 * an upload there — it will retry, drain their data, and eventually be
 * abandoned with the homework unsubmitted. So nothing leaves the device
 * until it is under 250 KB, the same ceiling answer_scripts uses.
 *
 * The encode step is injected rather than called directly. Canvas encoding
 * cannot run under `node --test`, and a compression ladder that is only
 * ever exercised in a browser is a compression ladder nobody has checked.
 * With the encoder as a parameter, the decisions — which scale to try, when
 * to stop, when to give up — are ordinary testable code, and the browser
 * supplies the one part that must be native.
 */

/** Bytes on the wire. Matches answer_scripts and 038's CHECK constraint. */
export const MAX_MEDIA_BYTES = 262144;
/** A spoken answer, not a phone left recording in a pocket. */
export const MAX_VOICE_MS = 90000;

/**
 * Longest edge, in order of preference. A page of handwriting has to stay
 * legible after compression — that is the whole point of photographing it —
 * so the ladder starts at a size where a teacher can still read it and only
 * then trades resolution for bytes.
 */
export const SCALE_LADDER = [1600, 1280, 1024, 800] as const;
/** Quality steps tried at each scale before dropping to the next one. */
export const QUALITY_LADDER = [0.72, 0.6, 0.48] as const;

export type EncodeFn = (longestEdge: number, quality: number) => Promise<number>;

export interface CompressPlan {
  longestEdge: number;
  quality: number;
  bytes: number;
  attempts: number;
}

/**
 * Walk the ladder until the result fits, and report what it took.
 *
 * Quality is exhausted at each scale before the scale drops, because
 * dropping resolution costs legibility and dropping quality mostly costs
 * JPEG ringing the eye forgives. Returns null when even the smallest
 * combination overshoots — the caller must say so rather than upload
 * something that will fail.
 */
export async function planCompression(encode: EncodeFn): Promise<CompressPlan | null> {
  let attempts = 0;
  for (const longestEdge of SCALE_LADDER) {
    for (const quality of QUALITY_LADDER) {
      attempts++;
      const bytes = await encode(longestEdge, quality);
      if (bytes > 0 && bytes <= MAX_MEDIA_BYTES) {
        return { longestEdge, quality, bytes, attempts };
      }
    }
  }
  return null;
}

export type MediaKind = 'photo' | 'voice';

export interface MediaDraft {
  kind: MediaKind;
  bytes: number;
  durationMs?: number;
  sha256?: string;
}

export type MediaProblem =
  | 'too_large'
  | 'too_long'
  | 'empty'
  | 'kind_mismatch'
  | 'hash_invalid';

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * The same rules the sync applier and migration 038 enforce.
 *
 * Duplicated deliberately. The server is the authority — this check exists
 * so a student learns their recording is too long BEFORE it is queued in an
 * outbox they cannot see, waits for a connection, and comes back as a
 * rejection hours later. Client validation is a courtesy; it is never the
 * boundary.
 */
export function checkMedia(d: MediaDraft): MediaProblem | null {
  if (!Number.isInteger(d.bytes) || d.bytes <= 0) return 'empty';
  if (d.bytes > MAX_MEDIA_BYTES) return 'too_large';
  if (d.sha256 !== undefined && !HEX64.test(d.sha256)) return 'hash_invalid';
  if (d.kind === 'photo' && d.durationMs != null) return 'kind_mismatch';
  if (d.kind === 'voice') {
    if (!Number.isInteger(d.durationMs) || (d.durationMs ?? 0) <= 0) return 'empty';
    if ((d.durationMs ?? 0) > MAX_VOICE_MS) return 'too_long';
  }
  return null;
}

/** What a student is told. Never a code, never a byte count they cannot act on. */
export const MEDIA_PROBLEM_BN: Record<MediaProblem, string> = {
  too_large: 'ছবিটি অনেক বড় — আরও কাছ থেকে বা কম আলোয় আবার তুলুন।',
  too_long: 'রেকর্ডিং ৯০ সেকেন্ডের বেশি — ছোট করে আবার বলুন।',
  empty: 'কিছু পাওয়া যায়নি — আবার চেষ্টা করুন।',
  kind_mismatch: 'ফাইলটি ঠিকমতো তৈরি হয়নি — আবার চেষ্টা করুন।',
  hash_invalid: 'ফাইলটি ঠিকমতো তৈরি হয়নি — আবার চেষ্টা করুন।',
};

/** mm:ss for the recorder readout. Bangla digits, because a student reads it. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const latin = `${m}:${String(s).padStart(2, '0')}`;
  return latin.replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}
