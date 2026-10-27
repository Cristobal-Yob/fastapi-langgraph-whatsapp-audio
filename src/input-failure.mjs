const defaults = { download: 'download_failed', inspect: 'inspection_failed', stt: 'stt_failed',
  transcript_validation: 'invalid_transcript' };
const reasons = new Set([...Object.values(defaults), 'invalid_payload', 'stream_failed',
  'byte_limit', 'http_status', 'timeout', 'response_limit',
  'network_failed', 'sdk_setup_failed', 'sdk_stream_failed']);
const records = new WeakMap();

export class InputFailure extends Error {
  constructor(stage, reason, { httpStatus } = {}) {
    if (!Object.hasOwn(defaults, stage) || !reasons.has(reason)) throw Error('invalid_audio_diagnostic');
    super(stage === 'download' ? 'audio_download_unavailable' : 'audio_input_unavailable');
    const dto = { stage, reason };
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) dto.http_status = httpStatus;
    records.set(this, Object.freeze(dto));
  }
}
export function inputDiagnostic(error, stage = 'download') {
  // Never inspect arbitrary error messages, stacks, payloads or even custom getters.
  if (!Object.hasOwn(defaults, stage)) stage = 'download';
  return { ...(records.get(error) ?? { stage, reason: defaults[stage] ?? defaults.download }) };
}
export function asInputFailure(error, stage, reason = defaults[stage]) {
  return records.has(error) ? error : new InputFailure(stage, reason);
}
export function inputFailureText(stage) {
  return { download: 'No pude descargar ese audio. No se consultó al agente.',
    inspect: 'No pude validar ese audio. No se consultó al agente.',
    stt: 'No pude transcribir ese audio. No se consultó al agente.',
    transcript_validation: 'No obtuve una transcripción válida de ese audio. No se consultó al agente.'
  }[stage] ?? 'No pude procesar ese audio. No se consultó al agente.';
}
