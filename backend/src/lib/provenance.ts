/** Provenance fields carried by every data response ({run_id, step_s, precision_h}, contract/common.ts). */
import type { RunDoc } from '../repos/types.ts';
import { precisionH } from './time.ts';

export const provenanceOf = (run: Pick<RunDoc, '_id' | 'step_s'>) => ({ run_id: run._id, step_s: run.step_s, precision_h: precisionH(run.step_s) });
