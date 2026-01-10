export const NODE_SIZE_DISPLAY_SCALE = 10;
export const DEFAULT_NODE_SIZE_CM = 2;

export function nodeSizeCmToInternal(valueCm: number) {
  return valueCm / NODE_SIZE_DISPLAY_SCALE;
}

export function nodeSizeInternalToCm(internalValue: number) {
  return internalValue * NODE_SIZE_DISPLAY_SCALE;
}
