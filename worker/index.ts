type Env = {
  OPENROUTER_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  GROQ_MODEL?: string;
  PREFER_OPENROUTER_FIRST?: string;
  SOCRATA_APP_TOKEN?: string;

  CHICAGO_PERMITS_URL?: string;
  YAKIMA_PERMITS_URL?: string;
  SPOKANE_PERMITS_URL?: string;
  BOISE_PERMITS_URL?: string;
  CHATTANOOGA_PERMITS_URL?: string;
};

type Permit = {
  id: string;
  permitNumber?: string;
  address: string;
  city: string;
  description: string;
  estimatedCost: number;
  applicant: string;
  jobCategory?: string;
  issuedDate?: string;
  raw?: any;
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function normalizePermit(p: any): Permit {
  return {
    id: `PERMIT-${Date.now()}`,
    permitNumber: p.permitNumber || p.permit_ || p.permit || p.id || "UNKNOWN",
    address: p.address || "Unknown",
    city: p.city || "Unknown",
    description: p.description || "",
    estimatedCost: Number(p.estimatedCost || 0),
    applicant: p.applicant || "Unknown",
    jobCategory: p.jobCategory || "General",
    issuedDate: p.issuedDate || new Date().toISOString(),
    raw: p.raw || p.rawData || p
  };
}

function dorks(p: Permit) {
  return [
    `"${p.address} ${p.city}" permit`,
    `"${p.applicant}" construction`,
    `"${p.description}" contractor`,
    `site:linkedin.com "${p.applicant}"`,
    `"${p.city}" contractor`,
    `"${p.city}" supplier`,
    `"${p.city}" electrical contractor`,
    `"${p.city}" plumbing contractor`,
    `"${p.city}" signage company`,
    `"${p.city}" POS system restaurant`,
    `"${p.city}" fire alarm contractor`,
    `"${p.city}" low voltage contractor`,
    `"${p.city}" commercial insurance`,
    `"${p.city}" restaurant equipment supplier`
  ];
}

function extractJson(raw: string) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const startFence = raw.indexOf("```");
  if (startFence !== -1) {
    const fenceFree = raw.replace(/```json|```/gi, "").trim();
    try {
      return JSON.parse(fenceFree);
    } catch {}
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  return null;
}

async function callOpenRouter(env: Env, prompt: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://permit-intel.permit-intel.workers.dev",
      "X-Title": "PermitIntel OSINT"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || "openrouter/free",
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No markdown. No commentary." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text}`);
  const parsed = JSON.parse(text);
  return parsed?.choices?.[0]?.message?.content || "";
}

async function callGroq(env: Env, prompt: string) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No markdown. No commentary." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Groq ${res.status}: ${text}`);
  const parsed = JSON.parse(text);
  return parsed?.choices?.[0]?.message?.content || "";
}

function classifyPermitType(permit: Permit) {
  const text = `${permit.description} ${permit.jobCategory || ""}`.toLowerCase();

  if (text.includes("fire alarm")) return "fire_alarm";
  if (text.includes("restaurant")) return "restaurant_buildout";
  if (text.includes("tenant improvement") || text.includes("tenant")) return "tenant_improvement";
  if (text.includes("electrical")) return "electrical";
  if (text.includes("plumbing")) return "plumbing";
  if (text.includes("hvac") || text.includes("mechanical")) return "hvac";
  if (text.includes("sign")) return "signage";
  if (text.includes("roof")) return "roofing";
  if (text.includes("security") || text.includes("low voltage")) return "low_voltage";
  return "general";
}

function mapRole(rawRole: string) {
  const r = rawRole.toLowerCase();

  if (r.includes("owner")) return "owner";
  if (r.includes("web applicant")) return "web applicant";
  if (r.includes("applicant")) return "applicant";
  if (r.includes("electrical")) return "electrical contractor";
  if (r.includes("plumbing")) return "plumbing contractor";
  if (r.includes("architect")) return "architect";
  if (r.includes("engineer")) return "engineer";
  if (r.includes("general contractor") || r === "gc") return "general contractor";
  if (r.includes("representative")) return "representative";
  if (r.includes("fire alarm")) return "fire alarm contractor";
  return rawRole.toLowerCase();
}

function extractContactsFromRaw(raw: any) {
  const entities: any[] = [];
  if (!raw || typeof raw !== "object") return entities;

  for (let i = 1; i <= 10; i++) {
    const type = raw[`contact_${i}_type`];
    const name = raw[`contact_${i}_name`];
    if (!type || !name) continue;

    entities.push({
      role: mapRole(String(type)),
      entityName: String(name),
      confidence: "high",
      sourceHint: `raw.contact_${i}_type/raw.contact_${i}_name`,
      verificationNeeded: false,
      city: raw[`contact_${i}_city`] || undefined,
      state: raw[`contact_${i}_state`] || undefined,
      zipcode: raw[`contact_${i}_zipcode`] || undefined
    });
  }

  return entities;
}

function uniqueBy<T>(items: T[], keyFn: (x: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function playbookForType(type: string, permit: Permit) {
  const commonSOP = {
    step1: "Send a short permit alert to the highest-fit buyer.",
    step2: "Offer a one-page brief or first-look pack.",
    step3: "Frame value as early project visibility and scope relevance.",
    step4: "Upsell adjacent vertical packs after first engagement.",
    pricingModel: "One-off alert pack first, then weekly local intelligence subscription."
  };

  if (type === "fire_alarm") {
    return {
      primaryAngle: {
        title: "Life-safety contractor alert pack",
        whyFastest: "Fire alarm and compliance work is specialized, urgent, and easy to position as time-sensitive.",
        targetBuyer: "Fire alarm contractors, electrical contractors, monitoring providers",
        estimatedMonetization: "$99-$299 first transaction",
        outreachHook: `This ${permit.city} permit indicates active life-safety scope before broader market awareness.`
      },
      packagingIdeas: [
        { title: "Life-safety permit brief", sellTo: "fire alarm contractors", format: "one-page permit brief", pricingIdea: "$99-$199" },
        { title: "Compliance vendor pack", sellTo: "monitoring and inspection vendors", format: "multi-buyer opportunity sheet", pricingIdea: "$149-$299" }
      ],
      outreachAngles: [
        { vertical: "fire alarm contractor", hook: "This permit shows active fire alarm scope in a live building.", cta: "Want the permit brief?" },
        { vertical: "electrical contractor", hook: "This life-safety scope may create related electrical work.", cta: "Want the brief?" },
        { vertical: "monitoring provider", hook: "This building permit may create downstream monitoring and compliance demand.", cta: "Want the project brief?" }
      ],
      closingSOP: commonSOP
    };
  }

  if (type === "restaurant_buildout") {
    return {
      primaryAngle: {
        title: "Restaurant buildout multi-vendor pack",
        whyFastest: "Restaurant projects create clustered demand across trades and operations vendors.",
        targetBuyer: "Electrical/plumbing contractors, POS vendors, signage vendors",
        estimatedMonetization: "$99-$299 first sale",
        outreachHook: `This ${permit.city} restaurant-related project creates immediate trade and vendor demand.`
      },
      packagingIdeas: [
        { title: "Trade alert brief", sellTo: "electrical and plumbing contractors", format: "one-page permit brief", pricingIdea: "$49-$149" },
        { title: "Restaurant operations vendor pack", sellTo: "POS, signage, security vendors", format: "multi-buyer opportunity sheet", pricingIdea: "$99-$299" }
      ],
      outreachAngles: [
        { vertical: "electrical contractor", hook: "This restaurant project appears to include electrical scope.", cta: "Want the permit brief?" },
        { vertical: "plumbing contractor", hook: "This restaurant project may include plumbing and drainage scope.", cta: "Want the brief?" },
        { vertical: "POS vendor", hook: "This restaurant project may create upcoming POS demand.", cta: "Want the project brief?" }
      ],
      closingSOP: commonSOP
    };
  }

  if (type === "electrical") {
    return {
      primaryAngle: {
        title: "Electrical scope alert pack",
        whyFastest: "Explicit electrical scope is easy to package and sell quickly to local electricians.",
        targetBuyer: "Electrical contractors and suppliers",
        estimatedMonetization: "$49-$149 first sale",
        outreachHook: `A newly permitted project in ${permit.city} appears to include electrical scope.`
      },
      packagingIdeas: [
        { title: "Electrical permit brief", sellTo: "electrical contractors", format: "one-page trade brief", pricingIdea: "$49-$149" }
      ],
      outreachAngles: [
        { vertical: "electrical contractor", hook: "This project appears to include electrical scope.", cta: "Want the permit brief?" }
      ],
      closingSOP: commonSOP
    };
  }

  if (type === "plumbing") {
    return {
      primaryAngle: {
        title: "Plumbing scope alert pack",
        whyFastest: "Explicit plumbing scope can be sold quickly to commercial plumbers.",
        targetBuyer: "Plumbing contractors and suppliers",
        estimatedMonetization: "$49-$149 first sale",
        outreachHook: `A newly permitted project in ${permit.city} appears to include plumbing scope.`
      },
      packagingIdeas: [
        { title: "Plumbing permit brief", sellTo: "plumbing contractors", format: "one-page trade brief", pricingIdea: "$49-$149" }
      ],
      outreachAngles: [
        { vertical: "plumbing contractor", hook: "This project appears to include plumbing scope.", cta: "Want the permit brief?" }
      ],
      closingSOP: commonSOP
    };
  }

  return {
    primaryAngle: {
      title: "Specialty trade alert pack",
      whyFastest: "Commercial permits usually create immediate contractor and supplier demand.",
      targetBuyer: "Local contractors and suppliers",
      estimatedMonetization: "$49-$149 first sale",
      outreachHook: `A newly permitted project in ${permit.city} appears to create active local demand.`
    },
    packagingIdeas: [
      { title: "Trade alert brief", sellTo: "contractors and suppliers", format: "one-page permit brief", pricingIdea: "$49-$149" }
    ],
    outreachAngles: [
      { vertical: "contractor", hook: "This project appears to create nearby trade demand.", cta: "Want the permit brief?" }
    ],
    closingSOP: commonSOP
  };
}

function fallbackGraph(permit: Permit) {
  const permitType = classifyPermitType(permit);
  const playbook = playbookForType(permitType, permit);
  const contacts = uniqueBy(extractContactsFromRaw(permit.raw), (x) => `${x.role}:${x.entityName}`);

  const baseEntities = [
    {
      role: "applicant",
      entityName: permit.applicant,
      confidence: "high",
      sourceHint: "permit source payload",
      verificationNeeded: true
    },
    {
      role: "project address",
      entityName: permit.address,
      confidence: "high",
      sourceHint: "permit source payload",
      verificationNeeded: false
    }
  ];

  const manifestEntities = uniqueBy([...contacts, ...baseEntities], (x) => `${x.role}:${x.entityName}`);

  let buyerTargets: any[] = [];

  if (permitType === "fire_alarm") {
    buyerTargets = [
      {
        vertical: "fire alarm contractor",
        buyerType: "life-safety integrator",
        whyTheyBuy: "The permit explicitly references fire alarm system work.",
        speedToClose: 9,
        dealSizeEstimate: "$99-$299",
        packagingAngle: "life-safety permit brief",
        firstMessage: `A newly permitted project in ${permit.city} appears to include active fire alarm scope. Want the brief?`
      },
      {
        vertical: "electrical contractor",
        buyerType: "commercial electrician",
        whyTheyBuy: "Life-safety modifications often require related electrical work.",
        speedToClose: 8,
        dealSizeEstimate: "$99-$249",
        packagingAngle: "electrical follow-on scope brief",
        firstMessage: `This fire alarm-related permit may create electrical follow-on work. Want the brief?`
      },
      {
        vertical: "monitoring provider",
        buyerType: "life-safety monitoring vendor",
        whyTheyBuy: "Active life-safety modifications can create downstream monitoring and compliance demand.",
        speedToClose: 7,
        dealSizeEstimate: "$149-$299",
        packagingAngle: "monitoring/compliance brief",
        firstMessage: `This life-safety permit may create monitoring or compliance demand. Want the project brief?`
      }
    ];
  } else if (permitType === "restaurant_buildout") {
    buyerTargets = [
      {
        vertical: "electrical contractor",
        buyerType: "restaurant-focused commercial electrician",
        whyTheyBuy: "Restaurant projects frequently include power, lighting, and equipment needs.",
        speedToClose: 9,
        dealSizeEstimate: "$49-$149",
        packagingAngle: "restaurant electrical permit brief",
        firstMessage: `A newly permitted restaurant project in ${permit.city} appears to include electrical scope. Want the brief?`
      },
      {
        vertical: "plumbing contractor",
        buyerType: "restaurant-focused commercial plumber",
        whyTheyBuy: "Restaurant projects often require plumbing, drainage, and grease-related work.",
        speedToClose: 9,
        dealSizeEstimate: "$49-$149",
        packagingAngle: "restaurant plumbing permit brief",
        firstMessage: `This newly permitted restaurant project may include plumbing scope. Want the brief?`
      },
      {
        vertical: "POS vendor",
        buyerType: "restaurant technology vendor",
        whyTheyBuy: "Restaurant openings and remodels can create POS demand before launch.",
        speedToClose: 7,
        dealSizeEstimate: "$99-$299",
        packagingAngle: "restaurant ops vendor brief",
        firstMessage: `A restaurant project in ${permit.city} may create upcoming POS demand. Want the brief?`
      }
    ];
  } else {
    buyerTargets = [
      {
        vertical: "electrical contractor",
        buyerType: "local commercial electrician",
        whyTheyBuy: "The scope appears to reference electrical or remodel upgrades.",
        speedToClose: 9,
        dealSizeEstimate: "$49-$149",
        packagingAngle: "early-scope permit brief",
        firstMessage: `A newly permitted project in ${permit.city} appears to include electrical scope. Want the brief?`
      },
      {
        vertical: "plumbing contractor",
        buyerType: "local commercial plumber",
        whyTheyBuy: "The scope suggests plumbing-related work or remodel readiness.",
        speedToClose: 9,
        dealSizeEstimate: "$49-$149",
        packagingAngle: "trade-specific permit alert",
        firstMessage: `This newly permitted project may include plumbing scope. Want the brief?`
      }
    ];
  }

  return {
    primaryAngle: playbook.primaryAngle,
    opportunityGraph: {
      verticals: [
        {
          name: "electrical contractor",
          whyRelevant: "Electrical scope is common or explicitly referenced",
          whatTheySell: "Commercial electrical work",
          urgency: "high",
          estimatedValue: 9,
          easeOfSale: 9,
          firstDealFit: true
        },
        {
          name: "plumbing contractor",
          whyRelevant: "Plumbing scope often accompanies remodels and restaurant projects",
          whatTheySell: "Commercial plumbing work",
          urgency: "high",
          estimatedValue: 9,
          easeOfSale: 9,
          firstDealFit: true
        },
        {
          name: "general contractor",
          whyRelevant: "Project execution and oversight",
          whatTheySell: "Full project delivery",
          urgency: "high",
          estimatedValue: 8,
          easeOfSale: 8,
          firstDealFit: true
        },
        {
          name: "material supplier",
          whyRelevant: "Projects require materials and fixtures",
          whatTheySell: "Materials and fixtures",
          urgency: "medium",
          estimatedValue: 7,
          easeOfSale: 7,
          firstDealFit: false
        },
        {
          name: "signage company",
          whyRelevant: "Retail and restaurant projects often create signage demand",
          whatTheySell: "Exterior and interior signage",
          urgency: "medium",
          estimatedValue: 6,
          easeOfSale: 7,
          firstDealFit: false
        },
        {
          name: "POS vendor",
          whyRelevant: "Restaurant projects often create POS demand",
          whatTheySell: "POS hardware and setup",
          urgency: "medium",
          estimatedValue: 6,
          easeOfSale: 6,
          firstDealFit: false
        }
      ],
      crossSellChains: [
        {
          name: "Buildout chain",
          sequence: ["general contractor", "electrical contractor", "plumbing contractor", "material supplier"],
          whyItMatters: "Closest to immediate project spend"
        },
        {
          name: "Operations chain",
          sequence: ["POS vendor", "signage company", "security vendor", "internet provider"],
          whyItMatters: "Useful before opening and handoff"
        }
      ],
      buyerTypes: [
        {
          vertical: "electrical contractor",
          buyerType: "local commercial electrician",
          packagingAngle: "permit brief highlighting electrical scope"
        },
        {
          vertical: "plumbing contractor",
          buyerType: "local commercial plumber",
          packagingAngle: "permit brief highlighting plumbing scope"
        }
      ]
    },
    manifestEntities,
    buyerTargets,
    buyerRecon: {
      whyThisProjectMatters: "This project creates clustered vendor demand across trades and downstream operations.",
      urgencyReason: "Scope is active and trade-relevant now.",
      valueOfIntel: "Early notice before broader market awareness.",
      whatTheyMissWithoutIt: "They enter late after competitors or awarded trades are already engaged.",
      timingWindow: "Best within 24-72 hours of identification."
    },
    closingSOP: playbook.closingSOP,
    packagingIdeas: playbook.packagingIdeas,
    outreachAngles: playbook.outreachAngles,
    evidence: [
      "Address provided in permit source",
      "City provided in permit source",
      "Description provided in permit source",
      "Estimated cost or permit category indicates a meaningful project"
    ],
    inferences: [
      "Trade demand likely exists for contractors and suppliers",
      "Downstream operations vendors may become relevant depending on project type"
    ],
    unknowns: [
      "Named contractor not fully verified unless present in source contacts",
      "Owner not fully verified unless present in source contacts",
      "Award status unknown"
    ],
    verificationSteps: [
      "Verify city/county permit detail",
      "Check entity records for applicant",
      "Search address plus contractor combinations",
      "Search local vendors by scope"
    ]
  };
}

function mergeObjects(base: any, incoming: any) {
  const out = { ...base };
  for (const key of Object.keys(incoming || {})) {
    const value = incoming[key];
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value;
      continue;
    }

    if (typeof value === "object") {
      out[key] = mergeObjects(base[key] || {}, value);
      continue;
    }

    if (value !== "") out[key] = value;
  }
  return out;
}

function postProcessGraph(shaped: any, permit: Permit) {
  const contacts = extractContactsFromRaw(permit.raw);
  const permitType = classifyPermitType(permit);
  const playbook = playbookForType(permitType, permit);

  shaped.manifestEntities = uniqueBy(
    [...(shaped.manifestEntities || []), ...contacts],
    (x) => `${x.role}:${x.entityName}`
  );

  if (!Array.isArray(shaped.packagingIdeas) || shaped.packagingIdeas.length === 0) {
    shaped.packagingIdeas = playbook.packagingIdeas;
  }
  if (!Array.isArray(shaped.outreachAngles) || shaped.outreachAngles.length === 0) {
    shaped.outreachAngles = playbook.outreachAngles;
  }
  if (!shaped.closingSOP || Object.keys(shaped.closingSOP).length === 0) {
    shaped.closingSOP = playbook.closingSOP;
  }

  const hasElectricalContact = contacts.some(c => c.role.includes("electrical"));
  const hasFireAlarmType = permitType === "fire_alarm";

  if (!Array.isArray(shaped.buyerTargets) || shaped.buyerTargets.length === 0) {
    shaped.buyerTargets = fallbackGraph(permit).buyerTargets;
  }

  if (hasFireAlarmType) {
    const fireAlarmAlready = shaped.buyerTargets.some((b: any) =>
      String(b.vertical || "").toLowerCase().includes("fire alarm")
    );
    if (!fireAlarmAlready) {
      shaped.buyerTargets.unshift({
        vertical: "fire alarm contractor",
        buyerType: "life-safety integrator",
        whyTheyBuy: "The permit explicitly references fire alarm system work.",
        speedToClose: 9,
        dealSizeEstimate: "$99-$299",
        packagingAngle: "life-safety permit brief",
        firstMessage: `A newly permitted ${permit.city} project appears to include active fire alarm scope. Want the brief?`
      });
    }
  }

  if (hasElectricalContact) {
    const electricalAlready = shaped.buyerTargets.some((b: any) =>
      String(b.vertical || "").toLowerCase().includes("electrical")
    );
    if (!electricalAlready) {
      shaped.buyerTargets.unshift({
        vertical: "electrical contractor",
        buyerType: "named or local commercial electrician",
        whyTheyBuy: "The permit includes an electrical contact or electrical-related scope.",
        speedToClose: 9,
        dealSizeEstimate: "$99-$249",
        packagingAngle: "electrical permit brief",
        firstMessage: `A newly permitted project in ${permit.city} appears to include electrical scope. Want the brief?`
      });
    }
  }

  return shaped;
}

async function runLLMGraph(env: Env, permit: Permit) {
  const rawContacts = extractContactsFromRaw(permit.raw);
  const permitType = classifyPermitType(permit);

  const prompt = `
You are a permit intelligence monetization engine.

Return ONLY valid JSON with this exact structure:

{
  "primaryAngle": {
    "title": string,
    "whyFastest": string,
    "targetBuyer": string,
    "estimatedMonetization": string,
    "outreachHook": string
  },
  "opportunityGraph": {
    "verticals": [
      {
        "name": string,
        "whyRelevant": string,
        "whatTheySell": string,
        "urgency": "low" | "medium" | "high",
        "estimatedValue": number,
        "easeOfSale": number,
        "firstDealFit": boolean
      }
    ],
    "crossSellChains": [
      {
        "name": string,
        "sequence": string[],
        "whyItMatters": string
      }
    ],
    "buyerTypes": [
      {
        "vertical": string,
        "buyerType": string,
        "packagingAngle": string
      }
    ]
  },
  "manifestEntities": [],
  "buyerTargets": [],
  "buyerRecon": {},
  "closingSOP": {},
  "packagingIdeas": [],
  "outreachAngles": [],
  "evidence": [],
  "inferences": [],
  "unknowns": [],
  "verificationSteps": []
}

Rules:
- maximize total monetizable verticals
- highlight the fastest first deal
- keep it realistic for local B2B sales
- use the permit details directly
- do not invent impossible specifics
- if the permit is fire alarm or life safety related, prioritize fire alarm contractors, life-safety integrators, monitoring vendors, compliance/inspection vendors, and electrical follow-on
- if raw contacts exist, use them conceptually

Permit type:
${permitType}

Known raw contacts:
${JSON.stringify(rawContacts)}

Permit:
${JSON.stringify(permit)}
`;

  const preferOpenRouter = env.PREFER_OPENROUTER_FIRST !== "false";
  const order = preferOpenRouter ? ["openrouter", "groq"] : ["groq", "openrouter"];

  let raw = "";
  let providerSuccess = "";
  const providerTried: string[] = [];
  const errors: string[] = [];

  for (const provider of order) {
    try {
      providerTried.push(provider);
      if (provider === "openrouter" && env.OPENROUTER_API_KEY) {
        raw = await callOpenRouter(env, prompt);
        providerSuccess = "openrouter";
        break;
      }
      if (provider === "groq" && env.GROQ_API_KEY) {
        raw = await callGroq(env, prompt);
        providerSuccess = "groq";
        break;
      }
    } catch (e: any) {
      errors.push(`${provider}: ${e?.message || "unknown error"}`);
    }
  }

  const parsed = extractJson(raw) || {};
  let shaped = mergeObjects(fallbackGraph(permit), parsed);
  shaped = postProcessGraph(shaped, permit);

  return {
    ...shaped,
    manifest: permit,
    dorkQueries: dorks(permit),
    debug: {
      llmReturned: !!raw,
      rawPreview: raw ? raw.slice(0, 300) : null,
      usedFallback: !extractJson(raw),
      providerTried,
      providerSuccess: providerSuccess || null,
      errorSummary: errors,
      permitType,
      rawContactCount: rawContacts.length,
      playbookUsed: permitType
    }
  };
}

async function fetchJson(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["X-App-Token"] = token;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function fetchChicago(env: Env, limit = 10) {
  const base = env.CHICAGO_PERMITS_URL || "https://data.cityofchicago.org/resource/ydr8-5enu.json";
  const url = `${base}?$limit=${limit}&$order=issue_date DESC`;
  const rows = await fetchJson(url, env.SOCRATA_APP_TOKEN);

  return (rows || []).map((r: any, i: number) => ({
    id: `chicago-${r.id || i}`,
    permitNumber: r.permit_ || r.id || "UNKNOWN",
    address: [r.street_number, r.street_direction, r.street_name].filter(Boolean).join(" ") || "Unknown",
    city: "Chicago",
    description: r.work_description || r.permit_type || "No description",
    estimatedCost: Number(r.estimated_cost || 0),
    applicant: r.applicant_1 || r.contact_1_name || "Unknown Applicant",
    jobCategory: r.permit_type || "General",
    issuedDate: r.issue_date || undefined,
    raw: r
  }));
}

function configuredCities(env: Env) {
  return [
    { key: "chicago", name: "Chicago", status: "live", sourceType: "official_socrata", urlConfigured: true },
    { key: "yakima", name: "Yakima", status: env.YAKIMA_PERMITS_URL ? "configured" : "awaiting_url", sourceType: "official_open_data", urlConfigured: !!env.YAKIMA_PERMITS_URL },
    { key: "spokane", name: "Spokane", status: env.SPOKANE_PERMITS_URL ? "configured" : "awaiting_url", sourceType: "official_open_data", urlConfigured: !!env.SPOKANE_PERMITS_URL },
    { key: "boise", name: "Boise", status: env.BOISE_PERMITS_URL ? "configured" : "awaiting_url", sourceType: "official_open_data", urlConfigured: !!env.BOISE_PERMITS_URL },
    { key: "chattanooga", name: "Chattanooga", status: env.CHATTANOOGA_PERMITS_URL ? "configured" : "awaiting_url", sourceType: "official_open_data", urlConfigured: !!env.CHATTANOOGA_PERMITS_URL }
  ];
}

async function fetchByCity(env: Env, city: string, limit = 10) {
  switch ((city || "").toLowerCase()) {
    case "chicago":
      return await fetchChicago(env, limit);
    case "yakima":
      if (!env.YAKIMA_PERMITS_URL) throw new Error("Yakima source URL not configured yet");
      return await fetchJson(env.YAKIMA_PERMITS_URL, env.SOCRATA_APP_TOKEN);
    case "spokane":
      if (!env.SPOKANE_PERMITS_URL) throw new Error("Spokane source URL not configured yet");
      return await fetchJson(env.SPOKANE_PERMITS_URL, env.SOCRATA_APP_TOKEN);
    case "boise":
      if (!env.BOISE_PERMITS_URL) throw new Error("Boise source URL not configured yet");
      return await fetchJson(env.BOISE_PERMITS_URL, env.SOCRATA_APP_TOKEN);
    case "chattanooga":
      if (!env.CHATTANOOGA_PERMITS_URL) throw new Error("Chattanooga source URL not configured yet");
      return await fetchJson(env.CHATTANOOGA_PERMITS_URL, env.SOCRATA_APP_TOKEN);
    default:
      throw new Error(`Unsupported city: ${city}`);
  }
}

function toOpenRefineRows(permits: any[]) {
  return permits.map((p: any) => ({
    id: p.id,
    permitNumber: p.permitNumber,
    city: p.city,
    address: p.address,
    description: p.description,
    estimatedCost: p.estimatedCost,
    applicant: p.applicant,
    jobCategory: p.jobCategory,
    issuedDate: p.issuedDate
  }));
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    if (url.pathname === "/cities" && req.method === "GET") {
      return json({ cities: configuredCities(env) });
    }

    if (url.pathname === "/playbooks" && req.method === "GET") {
      return json({
        playbooks: [
          "fire_alarm",
          "restaurant_buildout",
          "tenant_improvement",
          "electrical",
          "plumbing",
          "hvac",
          "signage",
          "roofing",
          "low_voltage",
          "general"
        ]
      });
    }

    if (url.pathname === "/fetch-permits" && req.method === "POST") {
      try {
        const body: any = await req.json();
        const city = body.city || "chicago";
        const limit = Number(body.limit || 10);
        const permits = await fetchByCity(env, city, limit);
        return json({ city, count: permits.length, permits });
      } catch (e: any) {
        return json({ error: e?.message || "fetch-permits failed" }, 400);
      }
    }

    if (url.pathname === "/export-openrefine" && req.method === "POST") {
      try {
        const body: any = await req.json();
        const city = body.city || "chicago";
        const limit = Number(body.limit || 50);
        const permits = await fetchByCity(env, city, limit);
        return json({ city, count: permits.length, rows: toOpenRefineRows(permits) });
      } catch (e: any) {
        return json({ error: e?.message || "export-openrefine failed" }, 400);
      }
    }

    if (url.pathname === "/analyze" && req.method === "POST") {
      try {
        const body: any = await req.json();
        const permit = normalizePermit(body.permit || body);
        return json(await runLLMGraph(env, permit));
      } catch (e: any) {
        return json({ error: e?.message || "analyze failed" }, 400);
      }
    }

    if (url.pathname === "/analyze-live" && req.method === "POST") {
      try {
        const body: any = await req.json();
        const city = body.city || "chicago";
        const limit = Number(body.limit || 5);
        const permits = await fetchByCity(env, city, limit);

        const analyses = [];
        for (const p of permits.slice(0, limit)) {
          analyses.push(await runLLMGraph(env, normalizePermit(p)));
        }

        return json({ city, count: analyses.length, analyses });
      } catch (e: any) {
        return json({ error: e?.message || "analyze-live failed" }, 400);
      }
    }

    if (url.pathname === "/analyze-batch" && req.method === "POST") {
      try {
        const body: any = await req.json();
        const permits = Array.isArray(body.permits) ? body.permits : [];
        const analyses = [];
        for (const p of permits) {
          analyses.push(await runLLMGraph(env, normalizePermit(p)));
        }
        return json({ count: analyses.length, analyses });
      } catch (e: any) {
        return json({ error: e?.message || "analyze-batch failed" }, 400);
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "permit-intel",
        routes: [
          "/cities",
          "/playbooks",
          "/fetch-permits",
          "/export-openrefine",
          "/analyze",
          "/analyze-live",
          "/analyze-batch"
        ],
        liveCity: "chicago",
        configurableCities: ["yakima", "spokane", "boise", "chattanooga"]
      });
    }

    return json({ error: "Not found" }, 404);
  }
};
