const config = window.APP_CONFIG;

const elements = Object.fromEntries(
  [
    "auth-badge", "setup-warning", "error-message", "success-message",
    "signed-out-view", "signed-in-view", "user-name", "unauthorized-view",
    "authorized-view", "approved-count", "duplicate-count", "ready-count",
    "missing-count", "sign-in-button", "sign-out-button", "refresh-button",
    "process-button", "confirm-dialog", "confirm-copy", "confirm-process-button",
    "results-panel", "result-approved", "result-added", "result-updated",
    "result-duplicates", "result-missing", "result-add-failures",
    "result-update-failures", "failure-details", "failure-output"
  ].map((id) => [id, document.getElementById(id)])
);

let identityManager;
let oauthInfo;
let portal;
let sourceLayer;
let targetLayer;
let GraphicClass;
let preview = null;
let busy = false;

function normalizeGlobalId(value) {
  if (value == null) return null;
  return String(value).trim().replace(/^\{|\}$/g, "").toLowerCase() || null;
}

function chunks(values, size) {
  const result = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function findField(layer, requestedName) {
  return layer.fields.find(
    (field) => field.name.toLowerCase() === requestedName.toLowerCase()
  );
}

function showMessage(kind, message) {
  for (const key of ["error-message", "success-message"]) elements[key].hidden = true;
  if (!message) return;
  elements[`${kind}-message`].textContent = message;
  elements[`${kind}-message`].hidden = false;
}

function setBusy(value, label = "Working…") {
  busy = value;
  elements["refresh-button"].disabled = value;
  elements["process-button"].disabled = value || !preview || preview.records.length === 0;
  elements["process-button"].textContent = value ? label : "Append approved businesses";
}

function validateConfiguration() {
  const missing = [];
  if (!config.oauthAppId || config.oauthAppId.startsWith("REPLACE_")) missing.push("oauthAppId");
  if (!config.authorizedGroupId || config.authorizedGroupId.startsWith("REPLACE_")) missing.push("authorizedGroupId");
  if (missing.length) {
    elements["setup-warning"].textContent = `Setup required: replace ${missing.join(" and ")} in config.js.`;
    elements["setup-warning"].hidden = false;
    elements["sign-in-button"].disabled = true;
    return false;
  }
  return true;
}

async function getAllFeaturesByWhere(layer, where, outFields, returnGeometry) {
  const idQuery = layer.createQuery();
  idQuery.where = where;
  const objectIds = await layer.queryObjectIds(idQuery);
  if (!objectIds?.length) return [];

  const features = [];
  for (const objectIdBatch of chunks(objectIds, config.batchSize)) {
    const query = layer.createQuery();
    query.objectIds = objectIdBatch;
    query.outFields = outFields;
    query.returnGeometry = returnGeometry;
    const result = await layer.queryFeatures(query);
    features.push(...result.features);
  }
  return features;
}

async function verifyGroupMembership(username, token) {
  const url =
    `${config.portalUrl}/sharing/rest/community/groups/` +
    `${encodeURIComponent(config.authorizedGroupId)}/users`;

  const body = new URLSearchParams({
    f: "json",
    token
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message || "Could not verify group membership."
    );
  }

  const names = [
    data.owner,
    ...(data.admins || []),
    ...(data.users || [])
  ]
    .filter(Boolean)
    .map((name) => String(name).toLowerCase());

  return names.includes(username.toLowerCase());
}

async function initializeLayers(PortalItem, FeatureLayer) {
  sourceLayer = new FeatureLayer({
    portalItem: new PortalItem({ id: config.sourceItemId, portal }),
    layerId: config.sourceLayerIndex
  });
  targetLayer = new FeatureLayer({
    portalItem: new PortalItem({ id: config.targetItemId, portal }),
    layerId: config.targetLayerIndex
  });
  await Promise.all([sourceLayer.load(), targetLayer.load()]);

  if (!findField(sourceLayer, config.reviewField)) {
    throw new Error(`The source does not contain ${config.reviewField}.`);
  }
  if (!sourceLayer.globalIdField) {
    throw new Error("The source layer does not have a GlobalID field.");
  }
  if (!findField(targetLayer, config.targetSourceIdField)) {
    throw new Error(`The target does not contain ${config.targetSourceIdField}. Add it before using this tool.`);
  }
  if (!sourceLayer.capabilities?.operations?.supportsEditing) {
    throw new Error("Your account cannot update the source layer.");
  }
  if (!targetLayer.capabilities?.operations?.supportsEditing) {
    throw new Error("Your account cannot add records to the target layer.");
  }
}

async function buildPreview() {
  if (busy) return;
  showMessage(null, null);
  setBusy(true, "Refreshing…");
  try {
    const reviewField = findField(sourceLayer, config.reviewField).name;
    const trackingField = findField(targetLayer, config.targetSourceIdField).name;

    const [existingFeatures, approvedFeatures] = await Promise.all([
      getAllFeaturesByWhere(targetLayer, `${trackingField} IS NOT NULL`, [trackingField], false),
      getAllFeaturesByWhere(sourceLayer, `${reviewField} = ${Number(config.approvedValue)}`, ["*"], true)
    ]);

    const existingIds = new Set(
      existingFeatures
        .map((feature) => normalizeGlobalId(feature.attributes[trackingField]))
        .filter(Boolean)
    );

    const writableTargetFields = new Map();
    for (const field of targetLayer.fields) {
      if (["oid", "global-id"].includes(field.type) || field.editable === false) continue;
      writableTargetFields.set(field.name.toLowerCase(), field.name);
    }

    const records = [];
    let duplicates = 0;
    let missingGlobalId = 0;

    for (const sourceFeature of approvedFeatures) {
      const attributes = sourceFeature.attributes;
      const sourceGlobalId = attributes[sourceLayer.globalIdField];
      const normalizedId = normalizeGlobalId(sourceGlobalId);
      if (!normalizedId) {
        missingGlobalId += 1;
        continue;
      }
      if (existingIds.has(normalizedId)) {
        duplicates += 1;
        continue;
      }

      const destinationAttributes = {};
      for (const [sourceName, sourceValue] of Object.entries(attributes)) {
        const destinationName = writableTargetFields.get(sourceName.toLowerCase());
        if (destinationName) destinationAttributes[destinationName] = sourceValue;
      }
      destinationAttributes[trackingField] = String(sourceGlobalId);

      records.push({
        sourceOid: attributes[sourceLayer.objectIdField],
        sourceGlobalId: normalizedId,
        targetFeature: new GraphicClass({
          geometry: sourceFeature.geometry,
          attributes: destinationAttributes
        })
      });
      existingIds.add(normalizedId);
    }

    preview = { approvedFeatures, records, duplicates, missingGlobalId, reviewField };
    elements["approved-count"].textContent = approvedFeatures.length;
    elements["duplicate-count"].textContent = duplicates;
    elements["ready-count"].textContent = records.length;
    elements["missing-count"].textContent = missingGlobalId;
  } catch (error) {
    preview = null;
    showMessage("error", error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function errorSummary(error) {
  if (!error) return "Unknown error";
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    details: error.details
  };
}

async function processApproved() {
  if (busy || !preview?.records.length) return;
  setBusy(true, "Appending…");
  showMessage(null, null);

  const totals = {
    approved: preview.approvedFeatures.length,
    added: 0,
    updated: 0,
    duplicates: preview.duplicates,
    missing: preview.missingGlobalId,
    addFailures: [],
    updateFailures: []
  };

  try {
    for (const recordBatch of chunks(preview.records, config.batchSize)) {
      let addResults;
      try {
        const response = await targetLayer.applyEdits(
          { addFeatures: recordBatch.map((record) => record.targetFeature) },
          { rollbackOnFailureEnabled: false }
        );
        addResults = response.addFeatureResults || [];
      } catch (error) {
        for (const record of recordBatch) {
          totals.addFailures.push({ sourceOid: record.sourceOid, error: errorSummary(error) });
        }
        continue;
      }

      const successfulRecords = [];
      recordBatch.forEach((record, index) => {
        const result = addResults[index];
        if (result && !result.error) {
          totals.added += 1;
          successfulRecords.push(record);
        } else {
          totals.addFailures.push({ sourceOid: record.sourceOid, error: errorSummary(result?.error) });
        }
      });

      if (!successfulRecords.length) continue;

      const updates = successfulRecords.map((record) => new GraphicClass({
        attributes: {
          [sourceLayer.objectIdField]: record.sourceOid,
          [preview.reviewField]: config.processedValue
        }
      }));

      try {
        const response = await sourceLayer.applyEdits(
          { updateFeatures: updates },
          { rollbackOnFailureEnabled: false }
        );
        const updateResults = response.updateFeatureResults || [];
        successfulRecords.forEach((record, index) => {
          const result = updateResults[index];
          if (result && !result.error) totals.updated += 1;
          else totals.updateFailures.push({ sourceOid: record.sourceOid, error: errorSummary(result?.error) });
        });
      } catch (error) {
        for (const record of successfulRecords) {
          totals.updateFailures.push({ sourceOid: record.sourceOid, error: errorSummary(error) });
        }
      }
    }

    renderResults(totals);
    showMessage("success", `Completed: ${totals.added} appended and ${totals.updated} marked processed.`);
    await buildPreview();
  } finally {
    setBusy(false);
  }
}

function renderResults(totals) {
  const values = {
    "result-approved": totals.approved,
    "result-added": totals.added,
    "result-updated": totals.updated,
    "result-duplicates": totals.duplicates,
    "result-missing": totals.missing,
    "result-add-failures": totals.addFailures.length,
    "result-update-failures": totals.updateFailures.length
  };
  for (const [id, value] of Object.entries(values)) elements[id].textContent = value;
  const failures = { appendFailures: totals.addFailures, statusUpdateFailures: totals.updateFailures };
  const hasFailures = totals.addFailures.length || totals.updateFailures.length;
  elements["failure-details"].hidden = !hasFailures;
  elements["failure-output"].textContent = hasFailures ? JSON.stringify(failures, null, 2) : "";
  elements["results-panel"].hidden = false;
}

async function start() {
  if (!validateConfiguration()) return;

  const [OAuthInfo, IdentityManager, Portal, PortalItem, FeatureLayer, Graphic] = await $arcgis.import([
    "@arcgis/core/identity/OAuthInfo.js",
    "@arcgis/core/identity/IdentityManager.js",
    "@arcgis/core/portal/Portal.js",
    "@arcgis/core/portal/PortalItem.js",
    "@arcgis/core/layers/FeatureLayer.js",
    "@arcgis/core/Graphic.js"
  ]);
  GraphicClass = Graphic;
  identityManager = IdentityManager;
  oauthInfo = new OAuthInfo({ appId: config.oauthAppId, portalUrl: config.portalUrl, popup: false });
  identityManager.registerOAuthInfos([oauthInfo]);

  elements["sign-in-button"].addEventListener("click", async () => {
    await identityManager.getCredential(`${config.portalUrl}/sharing`);
    window.location.reload();
  });
  elements["sign-out-button"].addEventListener("click", () => {
    identityManager.destroyCredentials();
    window.location.reload();
  });
  elements["refresh-button"].addEventListener("click", buildPreview);
  elements["process-button"].addEventListener("click", () => {
    elements["confirm-copy"].textContent = `${preview.records.length} new approved record${preview.records.length === 1 ? "" : "s"} will be appended. This action changes production data.`;
    elements["confirm-dialog"].showModal();
  });
  elements["confirm-dialog"].addEventListener("close", () => {
    if (elements["confirm-dialog"].returnValue === "confirm") processApproved();
  });

  try {
    await identityManager.checkSignInStatus(`${config.portalUrl}/sharing`);
  } catch {
    return;
  }

  try {
    const credential = await identityManager.getCredential(`${config.portalUrl}/sharing`);
    portal = new Portal({ url: config.portalUrl, authMode: "immediate" });
    await portal.load();

    elements["signed-out-view"].hidden = true;
    elements["signed-in-view"].hidden = false;
    elements["user-name"].textContent = `${portal.user.fullName} (${portal.user.username})`;
    elements["auth-badge"].textContent = "Signed in";
    elements["auth-badge"].className = "badge good";

    const authorized = await verifyGroupMembership(portal.user.username, credential.token);
    elements["unauthorized-view"].hidden = authorized;
    elements["authorized-view"].hidden = !authorized;
    if (!authorized) return;

    await initializeLayers(PortalItem, FeatureLayer);
    await buildPreview();
  } catch (error) {
    showMessage("error", error.message || String(error));
  }
}

start();
