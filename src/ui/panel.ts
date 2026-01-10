import type { Settings } from '../types';
import { NODE_SIZE_DISPLAY_SCALE, nodeSizeInternalToCm, nodeSizeCmToInternal } from '../config/nodeSizeScale';

const MIN_MAX_CONNECTIONS = 2;

export interface PanelCallbacks {
  refreshNodeSizes: () => void;
  refreshThreadAppearance: () => void;
  updateSpacingControls: () => void;
  onStructuralStiffnessChange: () => void;
  onConnectionStiffnessChange: () => void;
  onConnectionTensionChange: () => void;
  onInterpolatedBoostChange: () => void;
  onShowWireframeChange: (visible: boolean) => void;
  onNodeColorChange: () => void;
}

export function setupControlPanel(settings: Settings, callbacks: PanelCallbacks) {
  bindRange('intermediate-nodes', 'nodes-value', value => {
    settings.intermediateNodes = parseInt(value, 10);
  });

  const interpolateToggle = document.getElementById('interpolate-connections') as HTMLInputElement | null;
  if (interpolateToggle) {
    interpolateToggle.checked = settings.interpolateConnections;
    interpolateToggle.addEventListener('change', e => {
      settings.interpolateConnections = (e.target as HTMLInputElement).checked;
    });
  }

  const distanceToggle = document.getElementById('use-distance-spacing') as HTMLInputElement | null;
  if (distanceToggle) {
    distanceToggle.checked = settings.useDistanceSpacing;
    distanceToggle.addEventListener('change', e => {
      settings.useDistanceSpacing = (e.target as HTMLInputElement).checked;
      callbacks.updateSpacingControls();
    });
  }

  bindRange('distance-spacing', 'distance-spacing-value', value => {
    settings.distanceSpacing = parseInt(value, 10);
  });

  bindRange('node-size', 'node-size-value', value => {
    settings.nodeSize = nodeSizeCmToInternal(parseFloat(value));
    callbacks.refreshNodeSizes();
  }, value => parseFloat(value).toFixed(2));

  bindRange('connection-threshold', 'threshold-value', value => {
    settings.connectionThreshold = parseFloat(value);
  });

  const connectAnchors = document.getElementById('connect-anchors') as HTMLInputElement | null;
  if (connectAnchors) {
    connectAnchors.checked = settings.connectToAnchors;
    connectAnchors.addEventListener('change', e => {
      settings.connectToAnchors = (e.target as HTMLInputElement).checked;
    });
  }

  const connectSiblings = document.getElementById('connect-siblings') as HTMLInputElement | null;
  if (connectSiblings) {
    connectSiblings.checked = settings.connectToSiblings;
    connectSiblings.addEventListener('change', e => {
      settings.connectToSiblings = (e.target as HTMLInputElement).checked;
    });
  }

  bindRange('max-connections', 'max-connections-value', value => {
    settings.maxConnections = Math.max(MIN_MAX_CONNECTIONS, parseInt(value, 10));
  });

  const nodeColor = document.getElementById('node-color') as HTMLInputElement | null;
  if (nodeColor) {
    nodeColor.value = `#${Math.floor(settings.nodeColor).toString(16).padStart(6, '0')}`;
    nodeColor.addEventListener('input', e => {
      settings.nodeColor = parseInt((e.target as HTMLInputElement).value.replace('#', '0x'), 16);
      callbacks.onNodeColorChange();
    });
  }

  const threadColor = document.getElementById('thread-color') as HTMLInputElement | null;
  if (threadColor) {
    threadColor.value = `#${Math.floor(settings.threadColor).toString(16).padStart(6, '0')}`;
    threadColor.addEventListener('input', e => {
      settings.threadColor = parseInt((e.target as HTMLInputElement).value.replace('#', '0x'), 16);
      callbacks.refreshThreadAppearance();
    });
  }

  bindCheckbox('show-wireframe', settings.showWireframe, value => {
    settings.showWireframe = value;
    callbacks.onShowWireframeChange(value);
  });
  bindCheckbox('collision-toggle', settings.enableCollision, value => {
    settings.enableCollision = value;
  });
  bindCheckbox('enable-physics', settings.enablePhysics, value => {
    settings.enablePhysics = value;
  });

  bindRange('gravity', 'gravity-value', value => {
    settings.gravity = parseFloat(value);
  });
  bindRange('damping', 'damping-value', value => {
    settings.damping = parseFloat(value);
  });
  bindRange('substeps', 'substeps-value', value => {
    settings.substeps = parseInt(value, 10);
  });
  bindRange('structural-stiffness', 'structural-stiffness-value', value => {
    settings.structuralStiffness = parseFloat(value);
    callbacks.onStructuralStiffnessChange();
  });
  bindRange('connection-stiffness', 'connection-stiffness-value', value => {
    settings.connectionStiffness = parseFloat(value);
    callbacks.onConnectionStiffnessChange();
  });
  bindRange('connection-tension', 'connection-tension-value', value => {
    settings.connectionRestLengthFactor = parseFloat(value);
    callbacks.onConnectionTensionChange();
  }, v => `${v}×`);
  bindRange('interpolated-stiffness', 'interpolated-stiffness-value', value => {
    settings.interpolatedConnectionStiffness = parseFloat(value);
    callbacks.onInterpolatedBoostChange();
  }, v => `${v}×`);

  callbacks.updateSpacingControls();
  callbacks.onShowWireframeChange(settings.showWireframe);
}

export function syncControlsWithSettings(settings: Settings) {
  setRangeValue('intermediate-nodes', 'nodes-value', settings.intermediateNodes.toString());
  setCheckboxValue('interpolate-connections', settings.interpolateConnections);
  setCheckboxValue('use-distance-spacing', settings.useDistanceSpacing);
  setRangeValue('distance-spacing', 'distance-spacing-value', settings.distanceSpacing.toString());
  setRangeValue('node-size', 'node-size-value', nodeSizeInternalToCm(settings.nodeSize).toFixed(2));
  setRangeValue('connection-threshold', 'threshold-value', settings.connectionThreshold.toString());
  setCheckboxValue('connect-anchors', settings.connectToAnchors);
  setCheckboxValue('connect-siblings', settings.connectToSiblings);
  settings.maxConnections = Math.max(MIN_MAX_CONNECTIONS, settings.maxConnections);
  setRangeValue('max-connections', 'max-connections-value', settings.maxConnections.toString());
  setColorValue('node-color', settings.nodeColor);
  setColorValue('thread-color', settings.threadColor);
  setCheckboxValue('show-wireframe', settings.showWireframe);
  setCheckboxValue('collision-toggle', settings.enableCollision);
  setCheckboxValue('enable-physics', settings.enablePhysics);
  setRangeValue('gravity', 'gravity-value', settings.gravity.toString());
  setRangeValue('damping', 'damping-value', settings.damping.toString());
  setRangeValue('substeps', 'substeps-value', settings.substeps.toString());
  setRangeValue('structural-stiffness', 'structural-stiffness-value', settings.structuralStiffness.toString());
  setRangeValue('connection-stiffness', 'connection-stiffness-value', settings.connectionStiffness.toString());
  setRangeValue('connection-tension', 'connection-tension-value', settings.connectionRestLengthFactor.toString(), value => `${value}×`);
  setRangeValue('interpolated-stiffness', 'interpolated-stiffness-value', settings.interpolatedConnectionStiffness.toString(), value => `${value}×`);
  updateSpacingControlsDOM(settings.useDistanceSpacing);
}

export function updateSpacingControlsDOM(useDistanceSpacing: boolean) {
  const fixedGroup = document.getElementById('intermediate-nodes-group');
  const distanceGroup = document.getElementById('distance-spacing-group');
  if (!fixedGroup || !distanceGroup) return;
  if (useDistanceSpacing) {
    fixedGroup.classList.add('disabled');
    (document.getElementById('intermediate-nodes') as HTMLInputElement | null)?.setAttribute('disabled', 'true');
    distanceGroup.classList.remove('disabled');
    (document.getElementById('distance-spacing') as HTMLInputElement | null)?.removeAttribute('disabled');
  } else {
    distanceGroup.classList.add('disabled');
    (document.getElementById('distance-spacing') as HTMLInputElement | null)?.setAttribute('disabled', 'true');
    fixedGroup.classList.remove('disabled');
    (document.getElementById('intermediate-nodes') as HTMLInputElement | null)?.removeAttribute('disabled');
  }
}

function bindRange(id: string, valueDisplayId: string, onInput: (value: string) => void, formatter?: (value: string) => string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  const valueDisplay = document.getElementById(valueDisplayId);
  if (!input || !valueDisplay) return;
  const updateDisplay = (value: string) => {
    valueDisplay.textContent = formatter ? formatter(value) : value;
  };
  updateDisplay(input.value);
  input.addEventListener('input', e => {
    const val = (e.target as HTMLInputElement).value;
    updateDisplay(val);
    onInput(val);
  });
}

function bindCheckbox(id: string, initial: boolean, onChange: (value: boolean) => void) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.checked = initial;
  input.addEventListener('change', e => {
    onChange((e.target as HTMLInputElement).checked);
  });
}

function setRangeValue(id: string, displayId: string, value: string, formatter?: (value: string) => string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  const display = document.getElementById(displayId);
  if (!input || !display) return;
  input.value = value;
  display.textContent = formatter ? formatter(value) : value;
}

function setCheckboxValue(id: string, checked: boolean) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.checked = checked;
}

function setColorValue(id: string, color: number) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.value = `#${Math.floor(color).toString(16).padStart(6, '0')}`;
}
