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

        *** CRITICAL MEDICAL RULES (STRICT ENFORCEMENT) ***
        1. [CONTRAINDICATION - HIGH RISK] Nitrates (Nitroglycerin, Isosorbide) + PDE5 Inhibitors (Sildenafil, Tadalafil) -> Risk of fatal hypotension.
        2. [CONTRAINDICATION - HIGH RISK] Uncontrolled Hypertension (>170/110) -> Do not prescribe PDE5i.
        3. [CONTRAINDICATION - HIGH RISK] Recent MI/Stroke (<6 months).
        4. [INTERACTION - MEDIUM RISK] Alpha-blockers (Tamsulosin) + PDE5i -> Caution required, separate doses.
        5. [DOSING - MEDIUM RISK] Renal Impairment -> Adjust dose (max 2.5mg/5mg daily depending on CrCl).
        6. [DOSING - MEDIUM RISK] Age > 65 -> Start with lower dose.

        *** REQUIRED OUTPUT FORMAT (JSON ONLY) ***
        You must return valid JSON matching this schema exactly. Do not include markdown code blocks.
        {
          "riskScore": number (0-100, where 100 is maximal risk),
          "riskLevel": "LOW" | "MEDIUM" | "HIGH",
          "issues": ["List of specific contraindications", "Drug interactions", "Safety warnings"],
          "plan": {
            "medication": "Drug Name" | "None",
            "dosage": "e.g. 5mg Daily",
            "duration": "e.g. 30 Days",
            "rationale": "Concise clinical reasoning for this decision"
          },
          "alternatives": ["Alternative 1", "Alternative 2"],
          "confidenceScore": number (0.0 to 1.0)
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

    checkboxes.forEach(cb => cb.checked = false);

    if (type === 'standard') {
        nameInput.value = "Alex Mercer";
        medsInput.value = "Vitamin D";
        document.getElementById('p-weight').value = 80;
        document.getElementById('p-height').value = 180;
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
    } else {
        nameInput.value = "Robert Vance";
        medsInput.value = "Nitroglycerin, Atorvastatin";
        document.getElementById('p-weight').value = 95;
        document.getElementById('p-height').value = 175;
        document.getElementById('p-complaint').value = "Erectile Dysfunction";
        Array.from(checkboxes).find(cb => cb.value === 'Heart Disease').checked = true;
        Array.from(checkboxes).find(cb => cb.value === 'Hypertension').checked = true;
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
        weight: document.getElementById('p-weight').value,
        height: document.getElementById('p-height').value,
        conditions: Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value),
        medications: document.getElementById('p-meds').value,
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

function mockAnalyze(data) {
    const meds = (data.medications || "").toLowerCase();
    const conditions = data.conditions || [];
    const isNitro = meds.includes('nitro') || meds.includes('isosorbide');
    const isHTN = conditions.includes('Hypertension');

    if (isNitro) {
        return {
            riskScore: 98,
            riskLevel: "HIGH",
            issues: ["ABSOLUTE CONTRAINDICATION: Nitrates detected", "Risk of fatal hypotension"],
            plan: { medication: "None", dosage: "N/A", duration: "N/A", rationale: "Patient takes nitrates. PDE5 inhibitors are absolutely contraindicated." },
            alternatives: ["Vacuum Erection Device (VED)", "Intracavernosal Injections (Specialist)"],
            confidenceScore: 0.99
        };
    } else if (isHTN) {
        return {
            riskScore: 45,
            riskLevel: "MEDIUM",
            issues: ["Hypertension history - monitor BP", "Potential additive hypotensive effect"],
            plan: { medication: "Tadalafil", dosage: "2.5mg Daily", duration: "30 Days", rationale: "Starting low dose due to cardiovascular history. Monitor BP." },
            alternatives: ["Sildenafil 25mg on demand"],
            confidenceScore: 0.92
        };
    } else {
        return {
            riskScore: 12,
            riskLevel: "LOW",
            issues: ["None"],
            plan: { medication: "Tadalafil", dosage: "5mg Daily", duration: "90 Days", rationale: "Standard protocol. Patient fits safety profile." },
            alternatives: ["Sildenafil 50mg on demand", "Vardenafil 10mg"],
            confidenceScore: 0.98
        };
    }
}

function validateSchema(data) {
    if (!data.riskLevel || !data.plan || !data.issues) throw new Error("Invalid JSON Schema from LLM");
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(data.riskLevel)) throw new Error("Invalid Risk Level value");
}

// RENDER FUNCTIONS
function renderResults(data) {
    const riskOutput = document.getElementById('risk-output');
    const issueList = document.getElementById('issue-list');
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

