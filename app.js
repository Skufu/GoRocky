// CONFIG & STATE
const APP_CONFIG = window.__APP_CONFIG || {};
const API_BASE = (APP_CONFIG.apiBaseUrl || window.location.origin).replace(/\/$/, '');
const MODEL_AVAILABILITY = {
    mock: true,
    gemini: APP_CONFIG.models?.gemini !== false,
    openai: APP_CONFIG.models?.openai !== false
};
let apiKeys = {
    gemini: '',
    openai: ''
};
let activeModel = 'mock';
let currentPatientData = null;
let auditLog = [];
let reviewedPlan = null;

// The Medical System Prompt - Hard Constraints
const MEDICAL_PROMPT = `
        You are GoRocky Clinical AI, a high-precision medical decision support engine.
        Analyze the patient intake data and provide a structured JSON treatment plan.

        Patient intake fields: name, age, weight, height, BMI, blood pressure, lifestyle (smoking, alcohol, exercise), conditions, medications (with details), allergies, complaint.

        *** CRITICAL MEDICAL RULES (STRICT ENFORCEMENT) ***
        1. [CONTRAINDICATION - HIGH] Nitrates (Nitroglycerin, Isosorbide) + PDE5 inhibitors (Sildenafil, Tadalafil, Vardenafil, Avanafil) -> Risk of profound hypotension. Do NOT co-administer.
        2. [CONTRAINDICATION - HIGH] PDE5 inhibitor allergy or nitrate allergy -> Avoid prescribing PDE5 inhibitors.
        3. [INTERACTION - MEDIUM] Alpha-blockers (Tamsulosin, Terazosin, Doxazosin, Alfuzosin) + PDE5 inhibitors -> Separate dosing, start low.
        4. [INTERACTION - MEDIUM] Strong CYP3A4 inhibitors (Ketoconazole, Itraconazole, Ritonavir, Cobicistat, Clarithromycin) + PDE5 inhibitors -> Use lowest dose / avoid high doses.
        5. [DOSING - MEDIUM] Renal impairment (Kidney Disease) -> Start with lower PDE5 inhibitor dose (2.5mg/5mg daily max).
        6. [DOSING - MEDIUM] Age > 65 -> Start with lower dose.
        7. [CONTRAINDICATION - MEDIUM] Pregnancy -> Avoid PDE5 inhibitor use (safety not established).
        8. [CAUTION] Heart disease or uncontrolled hypertension -> Assess hemodynamic risk; prefer low dose or alternative.

        *** REQUIRED OUTPUT FORMAT (JSON ONLY) ***
        Return valid JSON (no markdown) matching:
        {
          "riskScore": number (0-100),
          "riskLevel": "LOW" | "MEDIUM" | "HIGH",
          "issues": ["List of contraindications/interactions/dosing warnings"],
          "interactions": [{"pair": "Drug A + Drug B/Class", "severity": "HIGH"|"MEDIUM"|"LOW", "note": "clinical rationale"}],
          "contraindications": [{"conditionOrAllergy": "string", "severity": "HIGH"|"MEDIUM"|"LOW", "note": "clinical rationale"}],
          "dosingConcerns": [{"factor": "age|renal|hepatic|other", "severity": "HIGH"|"MEDIUM"|"LOW", "recommendation": "actionable guidance"}],
          "plan": {
            "medication": "Drug Name" | "None",
            "dosage": "e.g. 2.5mg Daily",
            "duration": "e.g. 30 Days",
            "rationale": "Concise clinical reasoning"
          },
          "alternatives": ["Alternative 1", "Alternative 2"],
          "confidenceScore": number (0.0 to 1.0),
          "source": "model" | "rules" | "rules+model"
        }
        `;

// JSON schema for LLM response (lightweight, manual validation)
const RESPONSE_SCHEMA = {
    requiredStrings: ["riskLevel"],
    requiredNumbers: ["riskScore", "confidenceScore"],
    requiredPlanStrings: ["medication", "dosage", "duration", "rationale"],
    allowedRiskLevels: ["LOW", "MEDIUM", "HIGH"],
    arrays: ["issues", "interactions", "contraindications", "dosingConcerns", "alternatives"]
};

function modelEnabled(model) {
    return MODEL_AVAILABILITY[model] !== false;
}

function chooseDefaultModel() {
    // Force OpenAI when available; otherwise fall back to the configured preference.
    if (modelEnabled('openai')) return 'openai';
    const preferred = (APP_CONFIG.defaultModel || '').toLowerCase();
    if (preferred && modelEnabled(preferred)) return preferred;
    if (modelEnabled('gemini')) return 'gemini';
    return 'mock';
}

async function loadServerConfig() {
    try {
        const res = await fetch(`${API_BASE}/api/config`, { method: 'GET' });
        if (!res.ok) return;
        const data = await res.json();
        Object.assign(APP_CONFIG, data);
        MODEL_AVAILABILITY.gemini = APP_CONFIG.models?.gemini !== false;
        MODEL_AVAILABILITY.openai = APP_CONFIG.models?.openai !== false;
        MODEL_AVAILABILITY.mock = APP_CONFIG.models?.mock !== false;
        applyConfigDefaults();
    } catch (e) {
        console.warn("Failed to load server config", e);
    }
}

function applyConfigDefaults() {
    const selector = document.getElementById('model-selector');
    const nextModel = chooseDefaultModel();
    activeModel = nextModel;
    if (selector) {
        const hasOption = Array.from(selector.options).some(o => o.value === nextModel);
        if (hasOption) selector.value = nextModel;
    }
    updateModelDisplay();
}

// GLOBAL FUNCTIONS
window.switchView = function (view) {
    document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    window.scrollTo(0, 0);
};

window.openSettings = function () {
    document.getElementById('settings-modal').style.display = 'flex';
    document.getElementById('key-gemini').value = apiKeys.gemini;
    document.getElementById('key-openai').value = apiKeys.openai;
    document.getElementById('model-selector').value = activeModel;
};

window.saveSettings = function () {
    apiKeys.gemini = document.getElementById('key-gemini').value;
    apiKeys.openai = document.getElementById('key-openai').value;
    const nextModel = document.getElementById('model-selector').value;
    if (!modelEnabled(nextModel)) {
        alert("Selected model is disabled in configuration.");
        return;
    }
    activeModel = nextModel;
    updateModelDisplay();
    document.getElementById('settings-modal').style.display = 'none';
};

window.updateModelDisplay = function () {
    const selector = document.getElementById('model-selector');
    const display = document.getElementById('model-display');
    if (display) display.textContent = selector.options[selector.selectedIndex].text;
};

// Structured medication rows
function medRowsContainer() {
    return document.getElementById('med-rows');
}

function syncMedDetailsHidden() {
    const hidden = document.getElementById('p-meds-detail');
    if (hidden) hidden.value = collectMedRowsString();
}

function collectMedRowsString() {
    const container = medRowsContainer();
    if (!container) return '';
    const rows = Array.from(container.querySelectorAll('.med-row')).map(row => {
        const [drug, dose, freq] = Array.from(row.querySelectorAll('input')).map(i => i.value.trim());
        return { drug, dose, freq };
    }).filter(r => r.drug || r.dose || r.freq);

    return rows.map(r => [r.drug || 'Unknown med', r.dose || 'Unknown dose', r.freq || 'Unknown freq'].join(' | ')).join('\n');
}

function addMedRow(data = {}) {
    const container = medRowsContainer();
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'med-row';
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1fr 1fr auto';
    row.style.gap = '8px';
    row.style.marginTop = container.children.length ? '8px' : '0';

    const makeInput = (placeholder, value) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input-field';
        input.placeholder = placeholder;
        input.value = value || '';
        input.addEventListener('input', syncMedDetailsHidden);
        return input;
    };

    const drugInput = makeInput('Drug', data.drug);
    const doseInput = makeInput('Dose', data.dose);
    const freqInput = makeInput('Frequency', data.freq);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-ghost';
    removeBtn.style.border = 'var(--border-thin)';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove row';
    removeBtn.onclick = () => {
        container.removeChild(row);
        if (!container.children.length) addMedRow();
        syncMedDetailsHidden();
    };

    row.appendChild(drugInput);
    row.appendChild(doseInput);
    row.appendChild(freqInput);
    row.appendChild(removeBtn);

    container.appendChild(row);
    syncMedDetailsHidden();
}

function setMedRows(rows) {
    const container = medRowsContainer();
    if (!container) return;
    container.innerHTML = '';
    const payload = rows && rows.length ? rows : [{}];
    payload.forEach(r => addMedRow(r));
    syncMedDetailsHidden();
}

window.addMedRow = addMedRow;

window.prefill = function (type) {
    const nameInput = document.getElementById('p-name');
    const medsInput = document.getElementById('p-meds');
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    const ageInput = document.getElementById('p-age');
    const allergyInput = document.getElementById('p-allergies');
    const bpSys = document.getElementById('p-bp-sys');
    const bpDia = document.getElementById('p-bp-dia');
    const smoking = document.getElementById('p-smoking');
    const alcohol = document.getElementById('p-alcohol');
    const exercise = document.getElementById('p-exercise');
    const bmiField = document.getElementById('p-bmi');

    checkboxes.forEach(cb => cb.checked = false);
    allergyInput.value = '';
    bpSys.value = '';
    bpDia.value = '';
    smoking.value = '';
    alcohol.value = '';
    exercise.value = '';
    bmiField.value = '';

    if (type === 'standard') {
        nameInput.value = "Alex Mercer";
        medsInput.value = "Vitamin D";
        setMedRows([
            { drug: "Vitamin D", dose: "2000 IU", freq: "Daily" }
        ]);
        document.getElementById('p-weight').value = 78;
        document.getElementById('p-height').value = 178;
        ageInput.value = 42;
        bpSys.value = 122;
        bpDia.value = 78;
        smoking.value = "never";
        alcohol.value = "light";
        exercise.value = "3-5x/week";
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
        const pregBox = Array.from(checkboxes).find(cb => cb.value === 'Pregnant');
        if (pregBox) pregBox.checked = false;
    } else {
        nameInput.value = "Robert Vance";
        medsInput.value = "Nitroglycerin; Atorvastatin; Tamsulosin; Ketoconazole";
        setMedRows([
            { drug: "Nitroglycerin", dose: "0.4mg SL", freq: "PRN (chest pain)" },
            { drug: "Atorvastatin", dose: "40mg", freq: "QD" },
            { drug: "Tamsulosin", dose: "0.4mg", freq: "QD" },
            { drug: "Ketoconazole", dose: "200mg", freq: "QD (strong CYP3A4 inhibitor)" }
        ]);
        document.getElementById('p-weight').value = 98;
        document.getElementById('p-height').value = 173;
        ageInput.value = 68;
        bpSys.value = 176;
        bpDia.value = 104;
        smoking.value = "current";
        alcohol.value = "moderate";
        exercise.value = "1-2x/week";
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
        Array.from(checkboxes).forEach(cb => {
            cb.checked = ['Heart Disease', 'Hypertension', 'Kidney Disease'].includes(cb.value);
        });
        allergyInput.value = "Sildenafil (PDE5i allergy)";
    }
    recalcBMI();
};

window.initiateAnalysis = function () {
    if (!modelEnabled(activeModel)) {
        alert("ERROR: MODEL_DISABLED");
        return;
    }
    const sys = Number(document.getElementById('p-bp-sys').value) || 0;
    const dia = Number(document.getElementById('p-bp-dia').value) || 0;
    const h = Number(document.getElementById('p-height').value) || 0;
    const w = Number(document.getElementById('p-weight').value) || 0;
    if (sys && sys < 50 || dia && dia < 30) {
        alert("ERROR: INVALID_BLOOD_PRESSURE_VALUES");
        return;
    }
    if ((document.querySelector('input[type=\"checkbox\"][value=\"Hypertension\"]:checked')) && (!sys || !dia)) {
        alert("ERROR: MISSING_BLOOD_PRESSURE_FOR_HTN");
        return;
    }
    if (h > 0 && (h < 90 || h > 250)) {
        alert("ERROR: HEIGHT_OUT_OF_RANGE");
        return;
    }
    if (w > 0 && (w < 25 || w > 350)) {
        alert("ERROR: WEIGHT_OUT_OF_RANGE");
        return;
    }
    analyze();
};

window.reset = function () {
    document.querySelectorAll('input').forEach(i => i.value = '');
    document.querySelectorAll('input[type="checkbox"]').forEach(i => i.checked = false);
    document.getElementById('step-success').style.display = 'none';
    document.getElementById('step-results').style.display = 'none';
    document.getElementById('step-review').style.display = 'none';
    document.getElementById('step-intake').style.display = 'block';
};

window.finalize = function () {
    finalizeWithSummary(reviewedPlan);
};

function finalizeWithSummary(planData) {
    const logContainer = document.getElementById('audit-log-container');
    const reviewer = (document.getElementById('reviewer-name')?.value || "UNKNOWN_REVIEWER").toUpperCase();
    logContainer.innerHTML += generateAuditLog(`ANALYSIS_RUN_${activeModel.toUpperCase()}`, "");
    logContainer.innerHTML += generateAuditLog(`DOCTOR_REVIEW_${reviewer}`, "");
    if (planData) {
        logContainer.innerHTML += generateAuditLog(`FINAL_RISK_${planData.riskLevel || 'UNK'}`, `Risk: ${planData.riskLevel || 'UNK'} Score: ${planData.riskScore ?? '--'}`);
        logContainer.innerHTML += generateAuditLog(`FINAL_PLAN_${(planData.plan?.medication || 'NONE').toUpperCase()}`, `Med: ${planData.plan?.medication || 'None'} | ${planData.plan?.dosage || ''} | ${planData.plan?.duration || ''}`);
    }
    logContainer.innerHTML += generateAuditLog("RX_SENT_TO_PHARMACY", "");

    document.getElementById('step-results').style.display = 'none';
    document.getElementById('step-review').style.display = 'none';
    document.getElementById('step-success').style.display = 'block';
}

// CORE LOGIC
async function analyze() {
    const name = document.getElementById('p-name').value;
    if (!name) {
        alert("ERROR: NAME_FIELD_MISSING");
        return;
    }
    const sys = Number(document.getElementById('p-bp-sys').value) || 0;
    const dia = Number(document.getElementById('p-bp-dia').value) || 0;
    if ((sys && sys < 50) || (dia && dia < 30)) {
        alert("ERROR: INVALID_BLOOD_PRESSURE_VALUES");
        return;
    }

    const scanner = document.getElementById('scanner');
    scanner.style.display = 'block';
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('step-intake').style.display = 'none';
    document.getElementById('step-processing').style.display = 'block';
    scanner.style.display = 'none';

    const logContainer = document.getElementById('terminal-log');
    logContainer.innerHTML = '';
    const addLog = async (text) => {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = text;
        logContainer.appendChild(line);
        logContainer.scrollTop = logContainer.scrollHeight;
        await new Promise(r => setTimeout(r, 300));
    };

    await addLog("INITIALIZING DIAGNOSTIC ENGINE...");
    await addLog(`ACTIVE MODEL: ${activeModel.toUpperCase()}`);
    await addLog("PARSING CLINICAL DATA...");
    recalcBMI();

    currentPatientData = {
        name: document.getElementById('p-name').value,
        weight: Number(document.getElementById('p-weight').value) || 0,
        height: Number(document.getElementById('p-height').value) || 0,
        age: Number(document.getElementById('p-age').value) || 0,
        bmi: Number(document.getElementById('p-bmi').value) || computeBMI(Number(document.getElementById('p-weight').value), Number(document.getElementById('p-height').value)) || 0,
        bpSystolic: Number(document.getElementById('p-bp-sys').value) || 0,
        bpDiastolic: Number(document.getElementById('p-bp-dia').value) || 0,
        smoking: document.getElementById('p-smoking').value,
        alcohol: document.getElementById('p-alcohol').value,
        exercise: document.getElementById('p-exercise').value,
        conditions: Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value),
        medications: document.getElementById('p-meds').value,
        medicationDetails: collectMedRowsString(),
        allergies: document.getElementById('p-allergies').value,
        complaint: document.getElementById('p-complaint').value || "General Checkup"
    };

    let result = null;

    try {
        if (activeModel === 'gemini') {
            await addLog("CONNECTING TO GOOGLE VERTEX/GEMINI...");
            result = await callGemini(currentPatientData);
        } else if (activeModel === 'openai') {
            await addLog("CONNECTING TO OPENAI GPT-4...");
            result = await callOpenAI(currentPatientData);
        } else {
            await addLog(`DISPATCHING TO BACKEND @ ${API_BASE}/api/diagnostics/mock ...`);
            result = await callBackendMock(currentPatientData);
        }

        if (activeModel !== 'mock') {
            result = mergeWithRules(result, currentPatientData);
        }

        await addLog("VALIDATING JSON SCHEMA...");
        validateSchema(result);

        try {
            const interactionsResp = await fetchInteractionChecks(currentPatientData);
            if (interactionsResp?.warnings?.length) {
                await addLog(`RX CHECK WARNINGS: ${interactionsResp.warnings.join(' | ')}`);
            }
            if (interactionsResp?.interactions?.length) {
                result.interactions = mergeInteractionLists(result.interactions || [], interactionsResp.interactions);
                await addLog(`RX CHECK FOUND ${interactionsResp.interactions.length} INTERACTION(S)`);
            } else {
                await addLog("RX CHECK: NO ADDITIONAL INTERACTIONS");
            }
        } catch (e) {
            console.warn("Interaction check failed", e);
            await addLog(`RX CHECK FAILED: ${e.message || e}`);
        }

        await addLog("ANALYSIS COMPLETE. RENDERING...");
        await new Promise(r => setTimeout(r, 500));

        renderResults(result);
        document.getElementById('step-processing').style.display = 'none';
        document.getElementById('step-results').style.display = 'block';

    } catch (e) {
        console.error(e);
        await addLog(`CRITICAL ERROR: ${e.message}`);
        if (e.name === 'ValidationError' && Array.isArray(e.issues)) {
            const formatted = e.issues.map(i => `- ${i.field || 'field'}: ${i.message}`).join('\n');
            await addLog("VALIDATION FAILED. PLEASE CORRECT INPUT.");
            alert(`Validation failed:\n${formatted}`);
            document.getElementById('step-processing').style.display = 'none';
            document.getElementById('step-intake').style.display = 'block';
            return;
        }
        document.getElementById('step-processing').style.display = 'none';
        document.getElementById('step-results').style.display = 'none';
        document.getElementById('step-intake').style.display = 'block';
        await addLog("DIAGNOSTIC RUN ABORTED. NO RESULTS GENERATED.");
        alert(`Analysis failed. Please retry.\n\nDetails: ${e.message || 'Unknown error'}`);
    }
}

// API FUNCTIONS
async function parseJsonStrict(response, label) {
    const raw = await response.text();
    if (!raw?.trim()) {
        throw new Error(`${label} returned empty body`);
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`${label} returned invalid JSON: ${err.message}`);
    }
}

async function callBackendMock(patientData) {
    const response = await fetch(`${API_BASE}/api/diagnostics/mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patientData)
    });
    if (!response.ok) {
        let text = await response.text();
        try {
            const json = JSON.parse(text || '{}');
            if (response.status === 422 && json.error === 'validation_failed' && Array.isArray(json.issues)) {
                const err = new Error('Validation failed');
                err.name = 'ValidationError';
                err.issues = json.issues;
                throw err;
            }
        } catch {
            // ignore parse issues and fall through to generic error
        }
        throw new Error(`Backend error (${response.status}): ${text}`);
    }
    return await parseJsonStrict(response, 'Mock API');
}

async function callGemini(patientData) {
    const response = await fetch(`${API_BASE}/api/diagnostics/gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patientData)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini proxy failed (${response.status}): ${text}`);
    }
    return await parseJsonStrict(response, 'Gemini proxy');
}

async function callOpenAI(patientData) {
    const response = await fetch(`${API_BASE}/api/diagnostics/openai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patientData)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI proxy failed (${response.status}): ${text}`);
    }
    return await parseJsonStrict(response, 'OpenAI proxy');
}

async function fetchInteractionChecks(patientData) {
    const meds = (patientData?.medications || '').trim();
    if (!meds) {
        return { interactions: [], warnings: [], resolved: [], unresolved: [], source: 'none' };
    }
    const payload = {
        medications: meds,
        medicationDetails: patientData?.medicationDetails || ''
    };
    const response = await fetch(`${API_BASE}/api/interactions/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Interactions check failed (${response.status}): ${text}`);
    }
    return await parseJsonStrict(response, 'Interactions check');
}

function mergeInteractionLists(base = [], incoming = []) {
    const dedup = new Map();
    const pushAll = (list, sourceLabel) => {
        list.forEach(item => {
            if (!item?.pair) return;
            const key = `${(item.pair || '').toLowerCase()}|${(item.note || '').toLowerCase()}`;
            if (!dedup.has(key)) {
                dedup.set(key, { ...item, source: item.source || sourceLabel });
            } else {
                const existing = dedup.get(key);
                const sevRank = { HIGH: 2, MEDIUM: 1, LOW: 0 };
                if ((sevRank[item.severity] || 0) > (sevRank[existing.severity] || 0)) {
                    dedup.set(key, { ...item, source: item.source || sourceLabel });
                }
            }
        });
    };
    pushAll(base, 'rules');
    pushAll(incoming, 'rxnav');
    return Array.from(dedup.values());
}

// Local safety rules engine for deterministic DDI/contra/dosing checks
const DRUG_CLASSES = {
    pde5i: ['sildenafil', 'tadalafil', 'vardenafil', 'avanafil'],
    nitrates: ['nitroglycerin', 'isosorbide', 'isosorbide dinitrate', 'isosorbide mononitrate'],
    alphaBlockers: ['tamsulosin', 'doxazosin', 'terazosin', 'alfuzosin'],
    cyp3a4Inhibitors: ['ketoconazole', 'itraconazole', 'ritonavir', 'cobicistat', 'clarithromycin']
};

// Embedded drug rules database for cross-checking model output
const DRUG_RULE_DB = [
    {
        id: 'nitrates+pde5i',
        type: 'interaction',
        severity: 'HIGH',
        match: { drugClassA: 'nitrates', drugClassB: 'pde5i' },
        note: 'Risk of profound hypotension; avoid co-administration.'
    },
    {
        id: 'alpha+pde5i',
        type: 'interaction',
        severity: 'MEDIUM',
        match: { drugClassA: 'alphaBlockers', drugClassB: 'pde5i' },
        note: 'Additive hypotension; separate dosing and start low.'
    },
    {
        id: 'cyp3a4+pde5i',
        type: 'interaction',
        severity: 'MEDIUM',
        match: { drugClassA: 'cyp3a4Inhibitors', drugClassB: 'pde5i' },
        note: 'Higher PDE5i levels; use lowest dose and monitor.'
    },
    {
        id: 'pregnancy+pde5i',
        type: 'contra',
        severity: 'MEDIUM',
        match: { condition: 'pregnant', requiresDrugClass: 'pde5i' },
        note: 'Safety in pregnancy not established; avoid PDE5 inhibitors.'
    },
    {
        id: 'renal+pde5i',
        type: 'dosing',
        severity: 'MEDIUM',
        match: { condition: 'kidney disease' },
        note: 'Max 2.5-5mg daily; monitor closely.'
    }
];

const SEVERITY_WEIGHT = { HIGH: 40, MEDIUM: 20, LOW: 10 };

function normalizeList(text) {
    return (text || '')
        .split(/[,;]/)
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);
}

function hasClassToken(tokens, classList) {
    return tokens.some(t => classList.some(drug => t.includes(drug)));
}

function hasClassTokenByName(tokens, className) {
    const list = DRUG_CLASSES[className] || [];
    return hasClassToken(tokens, list);
}

function parseMedDetails(medsText, detailText) {
    const src = (detailText && detailText.trim().length ? detailText : medsText) || '';
    return src
        .split(/\n|;/)
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => {
            const parts = t.split('|').map(p => p.trim()).filter(Boolean);
            if (parts.length === 3) {
                const [drug, dose, freq] = parts;
                return `${drug} — ${dose} — ${freq}`;
            }
            return t.replace(/,+\s*$/, '');
        });
}

function runSafetyEngine(data) {
    const meds = normalizeList(data.medications);
    const allergies = normalizeList(data.allergies);
    const conditions = (data.conditions || []).map(c => c.toLowerCase());
    const age = Number(data.age) || null;
    const bpSys = Number(data.bpSystolic) || 0;
    const bpDia = Number(data.bpDiastolic) || 0;
    const bmi = Number(data.bmi) || 0;
    const smoking = (data.smoking || "").toLowerCase();
    const alcohol = (data.alcohol || "").toLowerCase();
    const exercise = (data.exercise || "").toLowerCase();
    let riskBumps = 0;

    const hasPDE5i = hasClassToken(meds, DRUG_CLASSES.pde5i);
    const hasNitrates = hasClassToken(meds, DRUG_CLASSES.nitrates);
    const hasAlphaBlocker = hasClassToken(meds, DRUG_CLASSES.alphaBlockers);
    const hasCyp3a4Inhibitor = hasClassToken(meds, DRUG_CLASSES.cyp3a4Inhibitors);
    const pregnant = conditions.includes('pregnant');
    const kidneyDisease = conditions.includes('kidney disease');
    const liverDisease = conditions.includes('liver disease');
    const heartDisease = conditions.includes('heart disease');
    const hypertension = conditions.includes('hypertension');

    const allergyToPde5i = hasClassToken(allergies, DRUG_CLASSES.pde5i);
    const allergyToNitrates = hasClassToken(allergies, DRUG_CLASSES.nitrates);

    const interactions = [];
    const contraindications = [];
    const dosingConcerns = [];

    if (hasPDE5i && hasNitrates) {
        interactions.push({ pair: "Nitrates + PDE5i", severity: "HIGH", note: "Risk of profound hypotension; avoid co-administration." });
    }
    if (hasPDE5i && hasAlphaBlocker) {
        interactions.push({ pair: "Alpha-blocker + PDE5i", severity: "MEDIUM", note: "Additive hypotension; separate dosing and start low." });
    }
    if (hasPDE5i && hasCyp3a4Inhibitor) {
        interactions.push({ pair: "Strong CYP3A4 inhibitor + PDE5i", severity: "MEDIUM", note: "Higher PDE5i levels; use lowest dose and monitor." });
    }

    DRUG_RULE_DB.forEach(rule => {
        if (rule.type === 'interaction' && hasClassTokenByName(meds, rule.match.drugClassA) && hasClassTokenByName(meds, rule.match.drugClassB)) {
            interactions.push({ pair: `${rule.match.drugClassA}+${rule.match.drugClassB}`, severity: rule.severity, note: rule.note });
        }
        if (rule.type === 'contra') {
            const condMatch = rule.match.condition && conditions.includes(rule.match.condition);
            const drugMatch = rule.match.requiresDrugClass ? hasClassTokenByName(meds, rule.match.requiresDrugClass) : true;
            if (condMatch && drugMatch) {
                contraindications.push({ conditionOrAllergy: rule.match.condition, severity: rule.severity, note: rule.note });
            }
        }
        if (rule.type === 'dosing') {
            const condMatch = rule.match.condition && conditions.includes(rule.match.condition);
            if (condMatch) {
                dosingConcerns.push({ factor: rule.match.condition, severity: rule.severity, recommendation: rule.note });
            }
        }
    });

    if (hasNitrates) {
        contraindications.push({ conditionOrAllergy: "Nitrate therapy", severity: "HIGH", note: "Concurrent nitrate use contraindicates PDE5 inhibitors due to hypotension risk." });
    }
    if (bpSys >= 170 || bpDia >= 110) {
        contraindications.push({ conditionOrAllergy: "Severely elevated BP", severity: "HIGH", note: "Uncontrolled hypertension; PDE5 inhibitors contraindicated." });
        riskBumps += 10;
    } else if (bpSys >= 150 || bpDia >= 95) {
        contraindications.push({ conditionOrAllergy: "Elevated BP", severity: "MEDIUM", note: "Elevated blood pressure; use lowest dose and monitor." });
        riskBumps += 5;
    }
    if (allergyToPde5i) {
        contraindications.push({ conditionOrAllergy: "PDE5 inhibitor allergy", severity: "HIGH", note: "Do not prescribe PDE5 inhibitors." });
    }
    if (allergyToNitrates) {
        contraindications.push({ conditionOrAllergy: "Nitrate allergy", severity: "HIGH", note: "Avoid nitrates and PDE5 co-prescribing." });
    }
    if (pregnant) {
        contraindications.push({ conditionOrAllergy: "Pregnancy", severity: "MEDIUM", note: "Safety not established; avoid PDE5 inhibitors." });
    }
    if (heartDisease) {
        contraindications.push({ conditionOrAllergy: "Heart Disease", severity: "MEDIUM", note: "Assess hemodynamic reserve; prefer low dose or alternative." });
    }
    if (hypertension) {
        contraindications.push({ conditionOrAllergy: "Hypertension", severity: "MEDIUM", note: "Monitor BP; start low to avoid hypotension." });
    }

    if (age && age >= 65) {
        dosingConcerns.push({ factor: "Age >65", severity: "MEDIUM", recommendation: "Initiate at lowest dose; titrate cautiously." });
    }
    if (kidneyDisease) {
        dosingConcerns.push({ factor: "Renal impairment", severity: "MEDIUM", recommendation: "Max 2.5mg-5mg daily; monitor for hypotension." });
    }
    if (liverDisease) {
        dosingConcerns.push({ factor: "Hepatic impairment", severity: "MEDIUM", recommendation: "Use lowest dose; consider avoiding if severe." });
    }
    if (bmi >= 35) {
        dosingConcerns.push({ factor: "Obesity (BMI ≥35)", severity: "MEDIUM", recommendation: "Start lowest dose; monitor cardiovascular tolerance." });
        riskBumps += 5;
    } else if (bmi >= 30) {
        dosingConcerns.push({ factor: "Overweight (BMI ≥30)", severity: "LOW", recommendation: "Start low; encourage weight management and monitoring." });
        riskBumps += 2;
    }
    if (smoking === "current") {
        dosingConcerns.push({ factor: "Smoking", severity: "LOW", recommendation: "Counsel cessation; monitor CV risk with therapy." });
        riskBumps += 2;
    }
    if (alcohol === "heavy") {
        dosingConcerns.push({ factor: "Heavy alcohol use", severity: "MEDIUM", recommendation: "Avoid concurrent dosing; monitor BP and sedation risk." });
        riskBumps += 3;
    }
    if (exercise === "none") {
        dosingConcerns.push({ factor: "Sedentary", severity: "LOW", recommendation: "Encourage activity; monitor cardiometabolic risk." });
    }

    const allFindings = [...interactions, ...contraindications, ...dosingConcerns];
    const maxSeverity = allFindings.some(f => f.severity === "HIGH")
        ? "HIGH"
        : allFindings.some(f => f.severity === "MEDIUM")
            ? "MEDIUM"
            : "LOW";

    const score = Math.min(
        100,
        allFindings.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] || 0), 5 + riskBumps)
    );

    const riskLevel = maxSeverity === "HIGH"
        ? "HIGH"
        : score >= 60
            ? "HIGH"
            : score >= 30
                ? "MEDIUM"
                : "LOW";

    const issues = [];
    interactions.forEach(i => issues.push(`[${i.severity}] Interaction: ${i.pair} - ${i.note}`));
    contraindications.forEach(c => issues.push(`[${c.severity}] Contraindication: ${c.conditionOrAllergy} - ${c.note}`));
    dosingConcerns.forEach(d => issues.push(`[${d.severity}] Dosing: ${d.factor} - ${d.recommendation}`));
    if (issues.length === 0) issues.push("None");

    let medication = "Tadalafil";
    let dosage = "5mg Daily";
    let duration = "90 Days";
    const highBlocker = interactions.some(i => i.severity === "HIGH") || contraindications.some(c => c.severity === "HIGH");

    if (highBlocker) {
        medication = "None";
        dosage = "N/A";
        duration = "N/A";
    } else if (age >= 65 || kidneyDisease || liverDisease || hasAlphaBlocker || hasCyp3a4Inhibitor || hypertension || heartDisease) {
        dosage = "2.5mg Daily";
        duration = "30 Days";
    }

    const rationalePieces = [];
    if (medication === "None") {
        rationalePieces.push("Safety blockers present; pharmacotherapy deferred.");
    } else {
        rationalePieces.push("PDE5 inhibitor indicated; starting with conservative dosing due to risk factors.");
    }
    if (age >= 65) rationalePieces.push("Age >65");
    if (kidneyDisease) rationalePieces.push("Renal impairment");
    if (liverDisease) rationalePieces.push("Hepatic impairment");
    if (hasAlphaBlocker) rationalePieces.push("Alpha-blocker co-therapy");
    if (hasCyp3a4Inhibitor) rationalePieces.push("CYP3A4 inhibitor present");
    if (heartDisease) rationalePieces.push("Cardiovascular history");
    if (pregnant) rationalePieces.push("Pregnancy");

    const confidenceScore = Math.max(0.6, 1 - score / 120);
    const planConfidence = highBlocker ? 0.4 : confidenceScore;
    const alternativesWithConfidence = medication === "None"
        ? [{ option: "Vacuum erection device", confidence: 0.65 }, { option: "Specialist referral", confidence: 0.7 }]
        : [
            { option: "Sildenafil 25mg on demand", confidence: 0.7 },
            { option: "Vardenafil 10mg", confidence: 0.65 },
            { option: "Behavioral therapy", confidence: 0.6 }
        ];

    return {
        riskScore: score,
        riskLevel,
        issues,
        interactions,
        contraindications,
        dosingConcerns,
        plan: {
            medication,
            dosage,
            duration,
            rationale: rationalePieces.join("; ") || "Standard protocol."
        },
        alternatives: alternativesWithConfidence,
        confidenceScore,
        recommendationConfidence: { plan: planConfidence },
        source: "rules"
    };
}

function mergeWithRules(modelResult, patientData) {
    const rules = runSafetyEngine(patientData);
    const merged = { ...rules, ...modelResult };

    merged.interactions = rules.interactions;
    merged.contraindications = rules.contraindications;
    merged.dosingConcerns = rules.dosingConcerns;
    merged.issues = Array.from(new Set([...(modelResult.issues || []), ...(rules.issues || [])]));

    const level = higherRiskLevel(modelResult.riskLevel, rules.riskLevel);
    merged.riskLevel = level;
    merged.riskScore = Math.max(modelResult.riskScore || 0, rules.riskScore || 0);

    merged.plan = modelResult.plan || rules.plan;
    merged.alternatives = modelResult.alternatives || rules.alternatives;
    merged.confidenceScore = modelResult.confidenceScore ?? rules.confidenceScore;
    merged.source = modelResult.source ? `${modelResult.source}+rules` : "rules+model";

    return merged;
}

function higherRiskLevel(a, b) {
    const rank = { "LOW": 0, "MEDIUM": 1, "HIGH": 2 };
    return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

function mockAnalyze(data) {
    return runSafetyEngine(data);
}

function validateSchema(data) {
    if (!data || typeof data !== 'object') throw new Error("Invalid response payload");

    const ensureString = (val, fallback) => (typeof val === 'string' && val.trim() ? val : fallback);
    const ensureNumber = (val, fallback) => (typeof val === 'number' ? val : fallback);
    const ensureArray = (val) => (Array.isArray(val) ? val : []);

    // Coerce required scalars
    data.riskLevel = RESPONSE_SCHEMA.allowedRiskLevels.includes(data.riskLevel) ? data.riskLevel : "MEDIUM";
    data.riskScore = ensureNumber(data.riskScore, 0);
    data.confidenceScore = ensureNumber(data.confidenceScore, 0);

    // Coerce plan block instead of failing hard on missing fields
    const plan = (data.plan && typeof data.plan === 'object') ? data.plan : {};
    data.plan = {
        medication: ensureString(plan.medication, "None"),
        dosage: ensureString(plan.dosage, "Not specified"),
        duration: ensureString(plan.duration, "Not specified"),
        rationale: ensureString(plan.rationale, "No plan generated.")
    };

    // Arrays
    data.issues = ensureArray(data.issues);
    data.interactions = ensureArray(data.interactions);
    data.contraindications = ensureArray(data.contraindications);
    data.dosingConcerns = ensureArray(data.dosingConcerns);
    data.alternatives = ensureArray(data.alternatives);
}

// RENDER FUNCTIONS
function renderResults(data) {
    const riskOutput = document.getElementById('risk-output');
    const issueList = document.getElementById('issue-list');
    const interactionsList = document.getElementById('interactions-list');
    const contraList = document.getElementById('contra-list');
    const dosingList = document.getElementById('dosing-list');
    const planOutput = document.getElementById('plan-output');
    const rationaleOutput = document.getElementById('rationale-output');
    const altList = document.getElementById('alternatives-list');
    const confDisplay = document.getElementById('confidence-score');
    const vitalsSummary = document.getElementById('vitals-summary');
    const medsList = document.getElementById('meds-list');
    const confNote = document.getElementById('confidence-note');
    reviewedPlan = data;

    const colors = {
        "HIGH": { border: "var(--status-error)", bg: "#FEE2E2", text: "var(--status-error)" },
        "MEDIUM": { border: "var(--status-warning)", bg: "#FEF3C7", text: "var(--status-warning)" },
        "LOW": { border: "var(--status-success)", bg: "#E8F5E9", text: "var(--status-success)" }
    };
    const c = colors[data.riskLevel] || colors["LOW"];

    riskOutput.innerHTML = `
                <div class="risk-gauge" style="border-color: ${c.border}; background: ${c.bg};">
                    <div class="risk-score" style="color: ${c.text};">${data.riskScore}<span style="font-size:1rem; opacity:0.5">/100</span></div>
                    <div>
                        <div class="risk-label" style="color: ${c.text};">${data.riskLevel} RISK</div>
                        <div style="font-family: var(--font-tech);">STATUS: ${data.riskLevel === 'HIGH' ? 'REJECTED' : 'AUTHORIZED'}</div>
                    </div>
                </div>
            `;

    if (vitalsSummary && currentPatientData) {
        const bpText = (currentPatientData.bpSystolic || currentPatientData.bpDiastolic)
            ? `BP: ${currentPatientData.bpSystolic || '--'}/${currentPatientData.bpDiastolic || '--'}`
            : 'BP: --/--';
        const bmiText = currentPatientData.bmi ? `BMI: ${currentPatientData.bmi}` : 'BMI: --';
        const lifestyle = [
            currentPatientData.smoking ? `Smoking: ${currentPatientData.smoking}` : null,
            currentPatientData.alcohol ? `Alcohol: ${currentPatientData.alcohol}` : null,
            currentPatientData.exercise ? `Exercise: ${currentPatientData.exercise}` : null,
        ].filter(Boolean).join(' • ');
        vitalsSummary.innerHTML = `${bpText} • ${bmiText}${lifestyle ? ' • ' + lifestyle : ''}`;
    }

    const planConf = data.recommendationConfidence?.plan ?? data.confidenceScore ?? 0;
    const confPercent = Math.round(planConf * 100);
    confDisplay.textContent = `CONF: ${confPercent}%`;
    confDisplay.style.background = confPercent > 80 ? 'var(--bg-surface)' : 'rgba(255,255,255,0.5)';
    confDisplay.style.color = 'var(--ink-primary)';

    if (data.issues.length > 0 && data.issues[0] !== "None") {
        issueList.innerHTML = prioritizeIssues(data.issues).map(i => `
                    <li class="issue-item">
                        <div class="issue-icon" style="background:${i.color}; color:white;">!</div>
                        <span>${i.badge}${i.text}</span>
                    </li>`).join('');
    } else {
        issueList.innerHTML = `
                    <li class="issue-item" style="border-color:var(--status-success);">
                        <div class="issue-icon" style="background:var(--status-success); color:white;">✓</div>
                        <span>Safety protocols passed. No issues found.</span>
                    </li>`;
    }

    const renderDetailList = (items, target, emptyText) => {
        if (!target) return;
        if (!items || items.length === 0) {
            target.innerHTML = `<li class="issue-item" style="border-color:var(--status-success);"><div class="issue-icon" style="background:var(--status-success); color:white;">✓</div><span>${emptyText}</span></li>`;
            return;
        }
        target.innerHTML = items.map(item => {
            const sev = item.severity || 'LOW';
            const sevColor = sev === 'HIGH' ? 'var(--status-error)' : sev === 'MEDIUM' ? 'var(--status-warning)' : 'var(--status-success)';
            const badge = `<span style="display:inline-block; padding:2px 6px; border-radius:6px; background:${sevColor}; color:white; font-size:0.7rem; margin-right:6px;">${sev}</span>`;
            if (item.pair) {
                return `<li class="issue-item"><div class="issue-icon" style="background:${sevColor}; color:white;">!</div><span>${badge}${item.pair} — ${item.note}</span></li>`;
            }
            if (item.conditionOrAllergy) {
                return `<li class="issue-item"><div class="issue-icon" style="background:${sevColor}; color:white;">!</div><span>${badge}${item.conditionOrAllergy} — ${item.note}</span></li>`;
            }
            if (item.factor) {
                return `<li class="issue-item"><div class="issue-icon" style="background:${sevColor}; color:white;">!</div><span>${badge}${item.factor} — ${item.recommendation}</span></li>`;
            }
            return `<li class="issue-item"><div class="issue-icon" style="background:var(--status-warning); color:white;">!</div><span>${JSON.stringify(item)}</span></li>`;
        }).join('');
    };

    renderDetailList(data.interactions || [], interactionsList, "No interaction risks detected.");
    renderDetailList(data.contraindications || [], contraList, "No contraindications detected.");
    renderDetailList(data.dosingConcerns || [], dosingList, "No dosing concerns detected.");

    planOutput.innerHTML = `
                ${data.plan.medication}
                <span class="prescription-details">
                    ${data.plan.dosage} • ${data.plan.duration}
                </span>
            `;
    rationaleOutput.textContent = data.plan.rationale;

    if (data.alternatives && data.alternatives.length) {
        if (Array.isArray(data.alternatives) && typeof data.alternatives[0] === 'object') {
            altList.innerHTML = data.alternatives.map(a => `<li style="margin-bottom:6px;">- ${a.option || a} (${Math.round((a.confidence || 0.5) * 100)}% conf)</li>`).join('');
        } else {
            altList.innerHTML = data.alternatives.map(a => `<li style="margin-bottom:6px;">- ${a}</li>`).join('');
        }
    } else {
        altList.innerHTML = `<li>None available.</li>`;
    }

    if (medsList) {
        const parsed = parseMedDetails(currentPatientData?.medications, currentPatientData?.medicationDetails);
        medsList.innerHTML = parsed.length
            ? parsed.map(m => `<li style="margin-bottom:4px;">${m}</li>`).join('')
            : `<li>None provided.</li>`;
    }

    if (confNote) {
        const hardBlocker = (data.contraindications || []).some(c => c.severity === "HIGH");
        const isPDE5 = isPDE5Drug(data.plan.medication);
        if (data.confidenceScore <= 0.45 && (hardBlocker || isPDE5)) {
            confNote.style.display = 'block';
            confNote.textContent = 'Confidence capped due to high-risk blockers (e.g., nitrates/severe BP/PDE5).';
        } else {
            confNote.style.display = 'none';
            confNote.textContent = '';
        }
    }
}

function prioritizeIssues(rawIssues) {
    const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return rawIssues
        .map(txt => {
            let sev = 'LOW';
            if (/HIGH/i.test(txt)) sev = 'HIGH';
            else if (/MEDIUM/i.test(txt)) sev = 'MEDIUM';
            const color = sev === 'HIGH' ? 'var(--status-error)' : sev === 'MEDIUM' ? 'var(--status-warning)' : 'var(--status-success)';
            const badge = `<span style="display:inline-block; padding:2px 6px; border-radius:6px; background:${color}; color:white; font-size:0.7rem; margin-right:6px;">${sev}</span>`;
            return { text: txt.replace(/^\[.*?\]\s*/,'').trim(), sev, color, badge };
        })
        .sort((a, b) => (sevOrder[a.sev] ?? 3) - (sevOrder[b.sev] ?? 3));
}

// Doctor review workflow
function startReview() {
    if (!reviewedPlan) {
        alert("No plan available to review.");
        return;
    }
    document.getElementById('step-results').style.display = 'none';
    document.getElementById('step-review').style.display = 'block';

    document.getElementById('review-med').value = reviewedPlan.plan.medication || '';
    document.getElementById('review-dose').value = reviewedPlan.plan.dosage || '';
    document.getElementById('review-duration').value = reviewedPlan.plan.duration || '';
    document.getElementById('review-rationale').value = reviewedPlan.plan.rationale || '';
    document.getElementById('review-confidence').value = reviewedPlan.recommendationConfidence?.plan || reviewedPlan.confidenceScore || 0.9;
}

function backToResults() {
    document.getElementById('step-review').style.display = 'none';
    document.getElementById('step-results').style.display = 'block';
}

function finalizeReview() {
    const reviewer = document.getElementById('reviewer-name').value || "UNKNOWN_REVIEWER";
    const planMed = document.getElementById('review-med').value || reviewedPlan.plan.medication;
    const planDose = document.getElementById('review-dose').value || reviewedPlan.plan.dosage;
    const planDur = document.getElementById('review-duration').value || reviewedPlan.plan.duration;
    const planRat = document.getElementById('review-rationale').value || reviewedPlan.plan.rationale;
    let planConf = Number(document.getElementById('review-confidence').value);
    if (Number.isNaN(planConf)) planConf = reviewedPlan.confidenceScore || 0.9;

    reviewedPlan.plan = { medication: planMed, dosage: planDose, duration: planDur, rationale: planRat };
    reviewedPlan.recommendationConfidence = reviewedPlan.recommendationConfidence || {};
    const hasHardBlocker = (reviewedPlan.contraindications || []).some(c => c.severity === "HIGH");
    const planIsPDE5 = isPDE5Drug(planMed);
    if (!planIsPDE5 && !hasHardBlocker && planConf < 0.7) {
        planConf = 0.7;
    }
    reviewedPlan.recommendationConfidence.plan = planConf;
    reviewedPlan.confidenceScore = Math.min(1, Math.max(0, planConf));
    reviewedPlan.reviewer = reviewer;

    renderResults(reviewedPlan);
    finalizeWithSummary(reviewedPlan);
}

function isPDE5Drug(name) {
    if (!name) return false;
    const n = name.toLowerCase();
    return DRUG_CLASSES.pde5i.some(d => n.includes(d));
}

function generateAuditLog(action, summary) {
    const timestamp = new Date().toISOString();
    const hash = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const extra = summary ? `<span style="font-family: var(--font-tech); color: var(--ink-secondary);">${summary}</span>` : '';
    return `
                <div class="audit-entry">
                    <span>${timestamp}</span>
                    <span>${action.toUpperCase()}</span>
                    ${extra}
                    <span style="font-family:monospace;">${hash}</span>
                </div>
            `;
}

// APP INIT
document.addEventListener('DOMContentLoaded', () => {
    const dateEl = document.getElementById('current-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();

    updateModelDisplay();
    setMedRows([{}]);
    applyConfigDefaults();
    loadServerConfig();

    const weightEl = document.getElementById('p-weight');
    const heightEl = document.getElementById('p-height');
    [weightEl, heightEl].forEach(el => {
        if (el) el.addEventListener('input', recalcBMI);
    });
});

function recalcBMI() {
    const w = Number(document.getElementById('p-weight').value) || 0;
    const h = Number(document.getElementById('p-height').value) || 0;
    const bmiVal = computeBMI(w, h);
    if (bmiVal) {
        document.getElementById('p-bmi').value = bmiVal.toFixed(1);
    } else {
        document.getElementById('p-bmi').value = '';
    }
}

function computeBMI(weight, heightCm) {
    if (!weight || !heightCm) return null;
    const meters = heightCm / 100;
    if (meters <= 0) return null;
    return weight / Math.pow(meters, 2);
}

