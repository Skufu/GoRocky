// CONFIG & STATE
const API_BASE = (window.__APP_CONFIG?.apiBaseUrl || window.location.origin).replace(/\/$/, '');
let apiKeys = {
    gemini: '',
    openai: ''
};
let activeModel = 'mock';
let currentPatientData = null;
let auditLog = [];

// The Medical System Prompt - Hard Constraints
const MEDICAL_PROMPT = `
        You are GoRocky Clinical AI, a high-precision medical decision support engine.
        Analyze the patient intake data and provide a structured JSON treatment plan.

        Patient intake fields: name, age, weight, height, conditions, medications, allergies, complaint.

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
    activeModel = document.getElementById('model-selector').value;
    updateModelDisplay();
    document.getElementById('settings-modal').style.display = 'none';
};

window.updateModelDisplay = function () {
    const selector = document.getElementById('model-selector');
    const display = document.getElementById('model-display');
    if (display) display.textContent = selector.options[selector.selectedIndex].text;
};

window.prefill = function (type) {
    const nameInput = document.getElementById('p-name');
    const medsInput = document.getElementById('p-meds');
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    const ageInput = document.getElementById('p-age');
    const allergyInput = document.getElementById('p-allergies');

    checkboxes.forEach(cb => cb.checked = false);
    allergyInput.value = '';

    if (type === 'standard') {
        nameInput.value = "Alex Mercer";
        medsInput.value = "Vitamin D";
        document.getElementById('p-weight').value = 80;
        document.getElementById('p-height').value = 180;
        ageInput.value = 45;
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
    } else {
        nameInput.value = "Robert Vance";
        medsInput.value = "Nitroglycerin, Atorvastatin";
        document.getElementById('p-weight').value = 95;
        document.getElementById('p-height').value = 175;
        ageInput.value = 68;
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
        Array.from(checkboxes).find(cb => cb.value === 'Heart Disease').checked = true;
        Array.from(checkboxes).find(cb => cb.value === 'Hypertension').checked = true;
        const pregBox = Array.from(checkboxes).find(cb => cb.value === 'Pregnant');
        if (pregBox) pregBox.checked = false;
    }
};

window.initiateAnalysis = function () {
    if (activeModel !== 'mock') {
        if (activeModel === 'gemini' && !apiKeys.gemini) {
            alert("MISSING API KEY: Please configure Gemini Key in settings.");
            openSettings();
            return;
        }
        if (activeModel === 'openai' && !apiKeys.openai) {
            alert("MISSING API KEY: Please configure OpenAI Key in settings.");
            openSettings();
            return;
        }
    }
    analyze();
};

window.reset = function () {
    document.querySelectorAll('input').forEach(i => i.value = '');
    document.querySelectorAll('input[type="checkbox"]').forEach(i => i.checked = false);
    document.getElementById('step-success').style.display = 'none';
    document.getElementById('step-results').style.display = 'none';
    document.getElementById('step-intake').style.display = 'block';
};

window.finalize = function () {
    const logContainer = document.getElementById('audit-log-container');
    logContainer.innerHTML += generateAuditLog(`ANALYSIS_RUN_${activeModel.toUpperCase()}`);
    logContainer.innerHTML += generateAuditLog("PROVIDER_REVIEW_ACCEPTED");
    logContainer.innerHTML += generateAuditLog("RX_SENT_TO_PHARMACY");

    document.getElementById('step-results').style.display = 'none';
    document.getElementById('step-success').style.display = 'block';
};

// CORE LOGIC
async function analyze() {
    const name = document.getElementById('p-name').value;
    if (!name) {
        alert("ERROR: NAME_FIELD_MISSING");
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

    currentPatientData = {
        name: document.getElementById('p-name').value,
        weight: Number(document.getElementById('p-weight').value) || 0,
        height: Number(document.getElementById('p-height').value) || 0,
        age: Number(document.getElementById('p-age').value) || 0,
        conditions: Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value),
        medications: document.getElementById('p-meds').value,
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

        await addLog("ANALYSIS COMPLETE. RENDERING...");
        await new Promise(r => setTimeout(r, 500));

        renderResults(result);
        document.getElementById('step-processing').style.display = 'none';
        document.getElementById('step-results').style.display = 'block';

    } catch (e) {
        console.error(e);
        await addLog(`CRITICAL ERROR: ${e.message}`);
        await addLog("FALLING BACK TO SAFE MODE...");
        result = mockAnalyze(currentPatientData);
        renderResults(result);
        document.getElementById('step-processing').style.display = 'none';
        document.getElementById('step-results').style.display = 'block';
    }
}

// API FUNCTIONS
async function callBackendMock(patientData) {
    const response = await fetch(`${API_BASE}/api/diagnostics/mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patientData)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Backend error (${response.status}): ${text}`);
    }
    return await response.json();
}

async function callGemini(patientData) {
    const prompt = `Patient Data: ${JSON.stringify(patientData)}`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKeys.gemini}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: MEDICAL_PROMPT }] }
        })
    });
    if (!response.ok) throw new Error('Gemini API Failed');
    const data = await response.json();
    let text = data.candidates[0].content.parts[0].text;
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
}

async function callOpenAI(patientData) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKeys.openai}`
        },
        body: JSON.stringify({
            model: "gpt-4o",
            messages: [
                { role: "system", content: MEDICAL_PROMPT },
                { role: "user", content: JSON.stringify(patientData) }
            ],
            response_format: { type: "json_object" }
        })
    });
    if (!response.ok) throw new Error('OpenAI API Failed');
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}

// Local safety rules engine for deterministic DDI/contra/dosing checks
const DRUG_CLASSES = {
    pde5i: ['sildenafil', 'tadalafil', 'vardenafil', 'avanafil'],
    nitrates: ['nitroglycerin', 'isosorbide', 'isosorbide dinitrate', 'isosorbide mononitrate'],
    alphaBlockers: ['tamsulosin', 'doxazosin', 'terazosin', 'alfuzosin'],
    cyp3a4Inhibitors: ['ketoconazole', 'itraconazole', 'ritonavir', 'cobicistat', 'clarithromycin']
};

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

function runSafetyEngine(data) {
    const meds = normalizeList(data.medications);
    const allergies = normalizeList(data.allergies);
    const conditions = (data.conditions || []).map(c => c.toLowerCase());
    const age = Number(data.age) || null;

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

    if (hasNitrates) {
        contraindications.push({ conditionOrAllergy: "Nitrate therapy", severity: "HIGH", note: "Concurrent nitrate use contraindicates PDE5 inhibitors due to hypotension risk." });
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

    const allFindings = [...interactions, ...contraindications, ...dosingConcerns];
    const maxSeverity = allFindings.some(f => f.severity === "HIGH")
        ? "HIGH"
        : allFindings.some(f => f.severity === "MEDIUM")
            ? "MEDIUM"
            : "LOW";

    const score = Math.min(
        100,
        allFindings.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] || 0), 5)
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
        alternatives: medication === "None"
            ? ["Vacuum erection device", "Specialist referral"]
            : ["Sildenafil 25mg on demand", "Vardenafil 10mg", "Behavioral therapy"],
        confidenceScore,
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
    if (!data.riskLevel || !data.plan || !data.issues) throw new Error("Invalid JSON Schema from LLM");
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(data.riskLevel)) throw new Error("Invalid Risk Level value");
    data.interactions = data.interactions || [];
    data.contraindications = data.contraindications || [];
    data.dosingConcerns = data.dosingConcerns || [];
    data.plan = data.plan || { medication: "None", dosage: "N/A", duration: "N/A", rationale: "No plan generated." };
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

    const confPercent = Math.round((data.confidenceScore || 0) * 100);
    confDisplay.textContent = `CONF: ${confPercent}%`;
    confDisplay.style.background = confPercent > 80 ? 'var(--bg-surface)' : 'rgba(255,255,255,0.5)';
    confDisplay.style.color = 'var(--ink-primary)';

    if (data.issues.length > 0 && data.issues[0] !== "None") {
        issueList.innerHTML = data.issues.map(i => `
                    <li class="issue-item">
                        <div class="issue-icon" style="background:var(--status-warning); color:white;">!</div>
                        <span>${i}</span>
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
            if (item.pair) {
                return `<li class="issue-item"><div class="issue-icon" style="background:var(--status-warning); color:white;">!</div><span>[${item.severity}] ${item.pair} — ${item.note}</span></li>`;
            }
            if (item.conditionOrAllergy) {
                return `<li class="issue-item"><div class="issue-icon" style="background:var(--status-warning); color:white;">!</div><span>[${item.severity}] ${item.conditionOrAllergy} — ${item.note}</span></li>`;
            }
            if (item.factor) {
                return `<li class="issue-item"><div class="issue-icon" style="background:var(--status-warning); color:white;">!</div><span>[${item.severity}] ${item.factor} — ${item.recommendation}</span></li>`;
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
        altList.innerHTML = data.alternatives.map(a => `<li style="margin-bottom:6px;">- ${a}</li>`).join('');
    } else {
        altList.innerHTML = `<li>None available.</li>`;
    }
}

function generateAuditLog(action) {
    const timestamp = new Date().toISOString();
    const hash = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return `
                <div class="audit-entry">
                    <span>${timestamp}</span>
                    <span>${action.toUpperCase()}</span>
                    <span style="font-family:monospace;">${hash}</span>
                </div>
            `;
}

// APP INIT
document.addEventListener('DOMContentLoaded', () => {
    const dateEl = document.getElementById('current-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();

    updateModelDisplay();
});

