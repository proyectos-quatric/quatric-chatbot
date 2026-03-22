// QUATRIC SV — Chatbot Server v2.2
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import { Resend } from "resend";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── OpenAI ─────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Email via Resend (HTTP — funciona en Render free sin problemas SMTP) ───
const resend = new Resend(process.env.RESEND_API_KEY);

// ══════════════════════════════════════════════════════════════════════════════
// SESIONES
// ══════════════════════════════════════════════════════════════════════════════
const sessions = new Map();
const SESSION_TTL = 5 * 60 * 1000; // 5 minutos

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      data: {
        nombre: null, telefono: null, ubicacion: null, proyecto: null,
        tipo: null, capacidad: null, tension: null, fecha: null, correo: null,
      },
      history: [],
      leadSent: false,
      techQuestions: 0,
      conflict: null,
      emailUpdated: false,
      danielongoMode: false,
      pucsMode:      false,
      lastActivity: Date.now(),
    });
  }
  const s = sessions.get(id);
  s.lastActivity = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions)
    if (now - s.lastActivity > SESSION_TTL) sessions.delete(id);
}, 1 * 60 * 1000); // Revisar cada minuto en lugar de cada 10

// ══════════════════════════════════════════════════════════════════════════════
// REGEX
// ══════════════════════════════════════════════════════════════════════════════
const PHONE_RE = /\b([267]\d{3}[\s\-]?\d{4})\b/;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const CAP_RE = /(\d+[\.,]?\d*)\s*(kva|kw|amp(?:erios?|eres?)?|hp|watts?|vatios?)/i;
const TENSION_RE = /(\d{2,4})\s*v(?:oltios?|olts?)?\b/i;
const DATE_RE = /\b(hoy|ma[ñn]ana|esta semana|pr[óo]xima semana|este mes|pr[óo]ximo mes|urgente|lo antes posible|asap|\d+\s*d[íi]as?|\d+\s*semanas?|\d+\s*meses?)\b/i;
const LOCATION_RE = /\b(san salvador|santa ana|san miguel|sonsonate|chalatenango|cuscatl[áa]n|la libertad|la paz|la uni[óo]n|moraz[áa]n|san vicente|usulut[áa]n|ahuachap[áa]n|caba[ñn]as|santa tecla|mejicanos|soyapango|apopa|ilopango|antiguo cuscatl[áa]n|ciudad delgado|zacamil|merliot|lourdes|escal[óo]n|colonia|sensuntepeque)\b/i;
const TIPO_RES_RE = /\b(casa|hogar|vivien\w*|residen\w*|apartamento|apto|domicil\w*|habitaci[óo]n|cuarto)\b/i;
const TIPO_IND_RE = /\b(empresa|industrial|planta|f[áa]brica|gasolinera|bodega|negocio|comercial|taller|hotel|hospital|subestaci[óo]n|distribuci[óo]n|nave|almac[eé]n|local|sala|oficina|consultorio|cl[íi]nica|restaurante|tienda|farmacia|edificio|escuela|colegio|universidad|panaderia|autoparts)\b/i;
const NAME_RE = /(?:(?:me llamo|soy|mi nombre es|ll[áa]mame)\s+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}){0,2})|^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}){1,2})\s*[,\.]/im;
const NAME_BLOCK = /^(no|si|ok|ya|hola|buenas|gracias|bien|mal|claro|perfecto|listo|dale|bueno|quiero|tengo|necesito|eso|esto|aqui|ahi|pues|este|para|san|santa|santo|colonia|residencial|urbanizacion|urb|es|de|la|lo|las|los|un|una|el|mi|por|con|que|como|donde)/i;
// Palabras que indican que la respuesta NO es un nombre propio
const NOT_A_NAME_RE = /(san|santa|santo|colonia|urb\.?|urbanizaci[oó]n|ciudad|barrio|caser[ií]o|canton|aldea|municipio|departamento|zona|sector|boulevard|avenida|calle|pasaje|lote|manzana|bloque|edificio|local|negocio|empresa|proyecto|instalaci[oó]n|presupuesto|cotizaci[oó]n|trabajo|servicio)/i;
const PROYECTO_RE = /\b(instalaci[óo]n|cableado|transformador|tablero|panel|acometida|circuito|mantenimiento|revisi[óo]n|ampliaci[óo]n|subestaci[óo]n|alumbrado|medidor|generador|aire|aires|acondicionado|acondicionados|a\/c|minisplit|split|climatizaci[óo]n|extensi[óo]n|extensiones|tomacorriente|tomacorrientes|toma[s]?|enchufe[s]?|punto[s]? de luz|iluminaci[óo]n|luminaria[s]?|foco[s]?|reflector[es]?|l[aá]mpara[s]?|bombilla[s]?|interruptor[es]?|apagador[es]?|ventilador[es]?|calentador[es]?|ducha[s]? el[eé]ctrica[s]?|poste[s]?|canaleta[s]?|ducto[s]?|bandeja[s]?|ups|inversor[es]?|planta el[eé]ctrica|panel solar|fotovoltai\w*|poner|instalar|cambiar|reparar|revisar)\b/i;

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const capitalize = str => str.trim().split(/\s+/)
  .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");

function lastAsked(history) {
  const last = [...history].reverse().find(m => m.role === "assistant");
  if (!last) return null;
  const t = last.content.toLowerCase();
  if (/nombre completo|tu nombre|cómo te llamas|cuál es tu nombre|nombre y apellido|tu nombre completo/.test(t)) return "nombre";
  if (/tel[eé]fono|número de contacto|número cel/.test(t)) return "telefono";
  if (/correo|email/.test(t)) return "correo";
  if (/municipio|colonia|zona|ubicaci[oó]n|dónde est[aá]|en qué zona/.test(t)) return "ubicacion";
  if (/kva|amperios|capacidad|carga estimada/.test(t)) return "capacidad";
  if (/voltios|tensi[oó]n|nivel de voltaje/.test(t)) return "tension";
  if (/proyecto|instalaci[oó]n|qué necesitas|qué trabajo|en qué consiste/.test(t)) return "proyecto";
  if (/cuándo|fecha|plazo|para cuándo/.test(t)) return "fecha";
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTRACCIÓN DE DATOS
// ══════════════════════════════════════════════════════════════════════════════
function extractData(msg, session) {
  const d = session.data;
  const raw = msg.trim();
  const asked = lastAsked(session.history);

  // Por contexto conversacional
  if (asked === "nombre" && !d.nombre) {
    const palabras = raw.split(/\s+/);
    const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/;
    const lower = raw.toLowerCase();
    if (
      palabras.length >= 1 && palabras.length <= 4 &&
      palabras.every(p => soloLetras.test(p) && p.length >= 2) &&
      !NAME_BLOCK.test(palabras[0]) &&
      !NOT_A_NAME_RE.test(lower) &&           // no es una ubicación o término de negocio
      !LOCATION_RE.test(lower) &&             // no es un lugar conocido
      lower !== (d.ubicacion || "").toLowerCase()
    ) d.nombre = capitalize(raw);
  }
  if (asked === "telefono" && !d.telefono) {
    const digits = raw.replace(/\D/g, "");
    let local = digits.startsWith("503") && digits.length >= 10 ? digits.slice(3) : digits;
    if (digits.length >= 7 && digits.length <= 11 && /^[267]/.test(local)) d.telefono = digits;
  }
  if (asked === "correo" && !d.correo) {
    const fixed = raw.toLowerCase()
      .replace(/gmailcom$/, "gmail.com").replace(/hotmailcom$/, "hotmail.com")
      .replace(/yahoocom$/, "yahoo.com").replace(/outlookcom$/, "outlook.com");
    const m = fixed.match(EMAIL_RE);
    if (m) d.correo = m[0];
    else if (raw.includes("@")) d.correo = fixed.trim().slice(0, 80);
  }
  if (asked === "ubicacion" && !d.ubicacion && raw.length >= 3) d.ubicacion = raw.slice(0, 120);
  if (asked === "capacidad" && !d.capacidad) {
    const m = raw.match(CAP_RE);
    if (m) d.capacidad = m[0];
    else if (/^\d+([\.,]\d+)?$/.test(raw)) d.capacidad = raw + " kVA";
  }
  if (asked === "tension" && !d.tension) {
    const m = raw.match(TENSION_RE);
    if (m) d.tension = m[0];
    else if (/^\d{2,4}$/.test(raw)) d.tension = raw + "V";
  }
  if (asked === "proyecto" && !d.proyecto && raw.length >= 3) d.proyecto = raw.slice(0, 200);
  if (asked === "fecha" && !d.fecha && raw.length >= 2) d.fecha = raw.slice(0, 60);

  // Por regex (mensajes ricos)
  if (!d.tipo) {
    if (TIPO_RES_RE.test(raw)) d.tipo = "residencial";
    else if (TIPO_IND_RE.test(raw)) d.tipo = "industrial";
  }
  if (!d.telefono) { const m = raw.match(PHONE_RE); if (m) d.telefono = m[1].replace(/[\s\-]/g, ""); }
  if (!d.correo) { const m = raw.match(EMAIL_RE); if (m) d.correo = m[0].toLowerCase(); }
  if (!d.capacidad) { const m = raw.match(CAP_RE); if (m) d.capacidad = m[0]; }
  if (!d.tension) { const m = raw.match(TENSION_RE); if (m) d.tension = m[0]; }
  if (!d.fecha) { const m = raw.match(DATE_RE); if (m) d.fecha = m[0]; }
  if (!d.ubicacion && LOCATION_RE.test(raw)) d.ubicacion = raw.slice(0, 120);
  if (!d.proyecto && PROYECTO_RE.test(raw)) d.proyecto = raw.split(".")[0].slice(0, 200);

  // Fallback inteligente: si ya se conoce el tipo pero proyecto sigue null,
  // y el cliente dio una frase descriptiva SIN que el bot se lo hubiera pedido
  // (ni tampoco estaba respondiendo otro campo), capturarla como proyecto.
  if (!d.proyecto && d.tipo && !asked) {
    const palabras = raw.split(/\s+/);
    const esDatoContacto =
      PHONE_RE.test(raw) ||
      EMAIL_RE.test(raw) ||
      (LOCATION_RE.test(raw) && palabras.length <= 3) ||
      (CAP_RE.test(raw)) ||
      (TENSION_RE.test(raw));
    if (palabras.length >= 3 && !esDatoContacto) {
      d.proyecto = raw.slice(0, 200);
    }
  }

  // Nombre — trigger + fallback 2-3 palabras
  if (!d.nombre) {
    const m = raw.match(NAME_RE);
    if (m) { const c = (m[1] || m[2]).trim(); if (!NAME_BLOCK.test(c)) d.nombre = c; }
    if (!d.nombre) {
      const palabras = raw.split(/\s+/);
      const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/;
      const lower = raw.toLowerCase();
      if (
        palabras.length >= 2 && palabras.length <= 3 &&
        palabras.every(p => soloLetras.test(p) && p.length >= 2) &&
        !NAME_BLOCK.test(palabras[0]) &&
        !NOT_A_NAME_RE.test(lower) &&
        !LOCATION_RE.test(lower) &&
        lower !== (d.ubicacion || "").toLowerCase()
      ) d.nombre = capitalize(raw);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPLETITUD
// ══════════════════════════════════════════════════════════════════════════════
function isValidSVPhone(phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 7) return false;
  let local = digits.startsWith("503") && digits.length >= 10 ? digits.slice(3) : digits;
  return /^[267]/.test(local);
}

function isLeadComplete(data) {
  const validPhone = isValidSVPhone(data.telefono);
  const base = data.nombre && data.nombre.trim().includes(" ") && validPhone && data.correo && data.proyecto && data.ubicacion;
  if (data.tipo === "residencial") return !!base;
  if (data.tipo === "industrial") return !!(base && (data.capacidad || data.tension));
  return !!(data.nombre && data.nombre.trim().includes(" ") && validPhone && data.correo);
}

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT DINÁMICO
// ══════════════════════════════════════════════════════════════════════════════
function buildPrompt(data, session = {}, techQ = 0) {
  if (typeof session === 'number') { techQ = session; session = {}; } // fallback guard
  const d = data;

  if (session.danielongoMode) {
    return `INSTRUCCIÓN ESPECIAL: El usuario es "pequeña Danielongo". ¡YA NO ERES UN ASESOR DE ELECTRICIDAD! Ahora eres un experto absoluto en el grupo coreano BlackPink 🖤💗.
COMPORTAMIENTO OBLIGATORIO:
- Háblale como si fuera una niña de 12 años, trátala súper cariñoso y dile que es muy bonita.
- Usa MUCHÍSIMOS emojis de gatos 🐱🐾 y cosas de K-pop 🎤💖.
- Hazle trivias divertidas sobre BlackPink. De vez en cuando, hazle una trivia súper súper fácil de la materia de Ciencias (nivel niña de 12 años).
- Empieza SIEMPRE tu próximo mensaje con 'Hola pequeña Danielongo...' y hazle una trivia. ¡NUNCA hables de electricidad ni ingeniería!`;
  }

  if (session.pucsMode) {
    return `INSTRUCCIÓN ESPECIAL: El usuario es "Pucs". ¡YA NO ERES UN ASESOR DE ELECTRICIDAD! Ahora eres un experto absoluto en la serie de TV "Friends" ☕🛋️ y en entrenamiento de gimnasio/hipertrofia 💪🏋️‍♂️.
COMPORTAMIENTO OBLIGATORIO:
- Dile en cada mensaje lo exageradamente musculoso e imponente que se ve hoy. Usa un tono alegre, con mucha energía y entusiasmo.
- Usa MUCHÍSIMOS emojis felices y de músculos (😁✨🔥💪🦾🏋️‍♂️).
- Hazle trivias divertidas, predominantemente sobre "Friends". En menor cantidad, mézclale algunas trivias sobre ejercicios de hipertrofia muscular.
- Empieza SIEMPRE tu próximo mensaje elogiando los impresionantes músculos de Pucs, y hazle una trivia. ¡NUNCA le hables de electricidad ni ingeniería!`;
  }

  if (session.conflict) {
    return `REGLA DE CONFLICTO DE DATOS: El cliente acaba de dar un dato distinto para ${session.conflict.field}. 
Antes teníamos guardado: "${session.conflict.old}". Ahora dio: "${session.conflict.new}".
PREGUNTA OBLIGATORIA Y ÚNICA: Dile explícitamente "Noto que me diste otro ${session.conflict.field}. ¿Cuál es correcto, ${session.conflict.old} o ${session.conflict.new}?". 
NO APORTES NINGUNA OTRA INFORMACIÓN HASTA QUE LO ACLARE.`;
  }

  const techRule = techQ >= 2
    ? `TOPE TÉCNICO ACTIVO: Ya respondiste 2 consultas técnicas. Si hace otra consulta técnica, NO LA RESPONDAS bajo ninguna circunstancia. Di ESTRICTAMENTE: "Para ese detalle, uno de nuestros ingenieros te asesora mejor. ¿Te contactamos?"`
    : `Tienes permitido responder hasta ${2 - techQ} consulta(s) técnica(s) más. TU RESPUESTA TÉCNICA NO PUEDE SUPERAR LOS 50 CARACTERES ESTRICTAMENTE. Sé extremadamente breve.`;

  const priceRule = `REGLA DE PRECIOS — PROHIBICIÓN ABSOLUTA:
NUNCA des precios, estimados, rangos, aproximaciones ni costos de ningún tipo.
Esto incluye: "USD X", "entre X y Y", "aproximadamente X", "ronda los X", "costaría X".
Si el usuario pide un precio, estimado o cotización, responde SIEMPRE:
"Como asistente virtual no puedo brindarte precios por aquí, pero sabemos que cada instalación es única y requiere atención personalizada. 💡 ¿Me permites tomar tus datos para que nuestro equipo te contacte con una cotización a la medida de tu proyecto?"
Esta regla NO tiene excepciones bajo ninguna circunstancia.`;

  const outOfScopeRule = `REGLA DE FUERA DE ALCANCE MÁXIMA PRIORIDAD: Si el usuario pide o menciona cualquier cosa que NO sea puramente ingeniería eléctrica (ej. obra civil, diseño arquitectónico, albañilería, fontanería, pedir comida, temas ajenos), NUNCA sigas con el proceso de venta ni hagas preguntas para recolectar datos. Rechaza la solicitud explícitamente y de forma profesional. EJEMPLO OBLIGATORIO: "Es una solicitud muy interesante, aunque en QUATRIC nuestra área de especialidad es exclusivamente la ingeniería eléctrica. ⚡ ¿Hay algún proyecto eléctrico o instalación en la que te pueda asesorar?". (OJO EXCEPCIÓN IMPORTANTE: Los sistemas de Aire Acondicionado / Climatización SÍ son parte de nuestros servicios eléctricos, cotízalos y atiéndelos con total normalidad).`;

  const rejectionRule = `REGLA DE NEGATIVA/DESPEDIDA (MÁXIMA PRIORIDAD): Si el usuario indica explícitamente que "no" necesita ayuda, que "nada", o se despide cerrando la conversación (ej. "no gracias", "eso es todo"), RESPÓNDELE amablemente agradeciendo su contacto y poniéndote a su entera disposición para cualquier proyecto eléctrico en el futuro. TERMINA la conversación ahí. NUNCA le preguntes por sus datos (nombre, municipio, teléfono, etc.) ni intentes continuar la cotización bajo ninguna circunstancia.`;

  if (!d.tipo) {
    return `Eres el asistente virtual de QUATRIC, empresa salvadoreña de ingeniería eléctrica.
Servicios: estudios, diseños, construcción de proyectos ELÉCTRICOS, Aires Acondicionados, operación y mantenimiento. (SOLO ELECTRICIDAD / A.C.).

COMPORTAMIENTO:
- Saludo puro sin intención (solo "hola", "buenos días", "hi") → preséntate brevemente y pregunta en qué puedes ayudar HOY.
- Intención comercial clara ("necesito un presupuesto", "quiero cotizar", "necesito ayuda", "quiero una instalación") → NO te presentes de nuevo. Pregunta directamente: "¿Es para tu casa o para un negocio?" 
- Necesidad con contexto claro (menciona casa/empresa) → clasifica y avanza SIN preguntar el tipo.
- Pregunta técnica → respóndela brevemente y luego pregunta si necesita un presupuesto.
- NUNCA te presentes ni repitas el saludo si el usuario ya expresó una intención.
- NUNCA repitas la misma pregunta dos veces.
- Máximo 2 líneas.

${rejectionRule}
${outOfScopeRule}
${priceRule}

${techRule}`;
  }

  const confirmados = Object.entries(d).filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}:"${v}"`).join(", ");

  const faltanRes = [
    !d.proyecto && "en qué consiste el proyecto eléctrico",
    !d.ubicacion && "municipio o colonia",
    (!d.nombre || !d.nombre.trim().includes(" ")) && "nombre y apellido (o segundo nombre)",
    !d.telefono && "número de teléfono",
    !d.correo && "correo electrónico",
  ].filter(Boolean);

  const faltanInd = [
    !d.proyecto && "tipo de instalación o trabajo requerido",
    !d.ubicacion && "ubicación del proyecto",
    (!d.nombre || !d.nombre.trim().includes(" ")) && "nombre del contacto y apellido",
    !d.telefono && "teléfono de contacto",
    !d.correo && "correo electrónico",
    !d.capacidad && "capacidad estimada (kVA o amperios)",
    !d.tension && "nivel de tensión (voltios)",
    !d.fecha && "fecha estimada de inicio",
  ].filter(Boolean);

  const faltan = d.tipo === "residencial" ? faltanRes : faltanInd;

  if (faltan.length === 0) {
    return `Eres el asistente de QUATRIC. Lead ${d.tipo} COMPLETO.
Datos: ${confirmados}.
Agradece, confirma datos clave en 1 línea y di que un asesor contactará pronto. Máximo 3 líneas.
${rejectionRule}
${outOfScopeRule}
${priceRule}
${techRule}`;
  }

  return `Eres el asistente de QUATRIC (ingeniería eléctrica, El Salvador). Cliente: ${d.tipo}.
YA TIENES — NO volver a preguntar: ${confirmados || "ninguno"}.
ÚNICO DATO AHORA: "${faltan[0]}".

REGLAS:
1. UNA sola pregunta por ese dato. Nada más.
2. Confirma el dato recibido en media línea + pregunta inmediata. Ej: "Perfecto, San Salvador. ¿Cuál es tu nombre completo?"
3. Tu respuesta SIEMPRE termina con una pregunta.
4. Contexto si preguntan: "Para que nuestro representante te contacte y dé seguimiento."
5. Máximo 2 líneas. Tono amigable.
${rejectionRule}
${outOfScopeRule}
${priceRule}
${techRule}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL — LEAD INTERNO
// ══════════════════════════════════════════════════════════════════════════════
async function sendLeadEmail(data, tipo, history) {
  tipo = tipo || "sin clasificar";
  const nombre = data.nombre || "Sin nombre";
  const telefono = data.telefono || "—";
  const ubicacion = data.ubicacion || "—";
  const proyecto = data.proyecto || "—";

  const filas = [
    ["Tipo", tipo],
    ["Nombre", nombre],
    ["Teléfono", telefono],
    ["Correo", data.correo || "—"],
    ["Ubicación", ubicacion],
    ["Proyecto", proyecto],
    data.capacidad && ["Capacidad", data.capacidad],
    data.tension && ["Tensión", data.tension],
    data.fecha && ["Fecha", data.fecha],
  ].filter(Boolean)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;background:#f4f4f4;border:1px solid #ddd">${k}</td><td style="padding:6px 12px;border:1px solid #ddd">${v}</td></tr>`)
    .join("");

  const transcript = history.filter(m => m.role !== "system")
    .map(m => {
      const quien = m.role === "user" ? "👤 Cliente" : "🤖 Bot";
      const bg = m.role === "user" ? "#eef2ff" : "#f9f9f9";
      return `<tr style="background:${bg}"><td style="padding:5px 12px;font-weight:600;border:1px solid #eee;white-space:nowrap">${quien}</td><td style="padding:5px 12px;border:1px solid #eee">${m.content}</td></tr>`;
    }).join("");

  await resend.emails.send({
    from: "QUATRIC Chatbot <proyectos@quatricsv.com>",
    to: process.env.LEAD_EMAIL || "proyectos@quatricsv.com",
    subject: `🔌 Lead ${tipo.toUpperCase()} — ${nombre} | QUATRIC`,
    html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:auto">
<h2 style="background:#0A4946;color:#fff;padding:16px 20px;margin:0;border-radius:8px 8px 0 0">🔌 Nuevo Lead ${tipo} — QUATRIC SV</h2>
<div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
  <h3 style="margin-top:0">Datos del cliente</h3>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${filas}</table>
  <h3 style="margin-top:24px">Conversación</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px">${transcript}</table>
  <p style="font-size:11px;color:#999;margin-top:16px">Generado por QUATRIC Chatbot v2.2</p>
</div></body></html>`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EMAIL — CONFIRMACIÓN AL CLIENTE
// ══════════════════════════════════════════════════════════════════════════════
async function sendConfirmationEmail(data) {
  if (!data.correo || !data.correo.includes("@")) return;

  const nombre = data.nombre || "Cliente";
  const telefono = data.telefono || "—";
  const proyecto = data.proyecto || "—";
  const ubicacion = data.ubicacion || "—";

  const filas = [
    ["Nombre", nombre],
    ["Teléfono", telefono],
    ["Correo", data.correo],
    ["Proyecto", proyecto],
    ["Ubicación", ubicacion],
    data.capacidad && ["Capacidad", data.capacidad],
    data.tension && ["Tensión", data.tension],
  ].filter(Boolean)
    .map(([k, v]) => `<tr><td style="padding:8px 16px;font-weight:600;background:#f4f6ff;border:1px solid #dde3f0;width:130px">${k}</td><td style="padding:8px 16px;border:1px solid #dde3f0">${v}</td></tr>`)
    .join("");

  await resend.emails.send({
    from: "QUATRIC SV <proyectos@quatricsv.com>",
    to: data.correo,
    replyTo: "proyectos@quatricsv.com",
    subject: `✅ Recibimos tu solicitud, ${nombre} — QUATRIC SV`,
    html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f0f2f8;font-family:system-ui,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f8;padding:40px 0">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
      <tr><td style="background:#0A4946;padding:28px 32px">
        <p style="margin:0;color:#fff;font-size:20px;font-weight:700">⚡ QUATRIC SV</p>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px">Ingeniería Eléctrica · El Salvador</p>
      </td></tr>
      <tr><td style="padding:32px">
        <p style="margin:0 0 8px;font-size:19px;font-weight:600;color:#0A4946">¡Hola, ${nombre}! 👋</p>
        <p style="margin:0 0 24px;color:#444;font-size:14px;line-height:1.7">
          Hemos recibido tu solicitud. Un representante de QUATRIC te contactará a la brevedad.
        </p>
        <p style="margin:0 0 10px;font-weight:600;color:#0A4946;font-size:13px;text-transform:uppercase;letter-spacing:.5px">Tu solicitud</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin-bottom:24px">${filas}</table>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin-bottom:20px">
          <p style="margin:0;color:#166534;font-size:14px">
            ✅ <strong>Tu información ya está con nuestro equipo.</strong><br/>
            Te contactaremos al <strong>${telefono}</strong> o a este correo.
          </p>
        </div>
        <p style="margin:0;color:#666;font-size:13px">Consultas: <a href="mailto:proyectos@quatricsv.com" style="color:#0A4946;font-weight:600">proyectos@quatricsv.com</a></p>
      </td></tr>
      <tr><td style="background:#f4f6ff;padding:16px 32px;border-top:1px solid #e8ecf5;text-align:center">
        <p style="margin:0;color:#999;font-size:11px">© QUATRIC SV · Ingeniería Eléctrica · El Salvador</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// GUARDAR LEAD LOCAL
// ══════════════════════════════════════════════════════════════════════════════
function saveLeadToFile(data) {
  try {
    const path = "./leads.json";
    const leads = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf-8") || "[]") : [];
    leads.push({ ...data, guardado: new Date().toISOString() });
    fs.writeFileSync(path, JSON.stringify(leads, null, 2));
  } catch (e) { console.error("[QUATRIC] saveLeadToFile:", e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════════════════════════════════════════════
const rateStore = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateStore.get(ip) || []).filter(t => now - t < 60_000);
  hits.push(now);
  rateStore.set(ip, hits);
  return hits.length > 25;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════
app.post("/chat", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  if (isRateLimited(ip))
    return res.status(429).json({ error: "Demasiadas solicitudes. Espera un momento." });

  const { message, sessionId, reset } = req.body;

  if (!sessionId || typeof sessionId !== "string")
    return res.status(400).json({ error: "sessionId requerido" });

  // Nuevo: si el frontend refresca la página y manda { reset: true } borramos la sesión
  if (reset) {
    sessions.delete(sessionId);
    return res.json({ reply: "ok, sesión reiniciada externamente", meta: { reset: true } });
  }

  if (!message || typeof message !== "string" || !message.trim())
    return res.status(400).json({ error: "Mensaje vacío" });

  const trimmed = message.trim().slice(0, 600);
  const session = getSession(sessionId);

  if (/daniell?ongo/i.test(trimmed)) session.danielongoMode = true;
  if (/\bpucs\b/i.test(trimmed)) session.pucsMode = true;

  const UPDATE_RE = /\b(actualizar|cambiar|me equivoqu[eé]|no es|diferente|correcci[oó]n|corregir)\b/i;
  const isUpdate = UPDATE_RE.test(trimmed);

  // Corrección de emails ultra-robusta (gmil.co, gmai.com, etc.)
  let sEmail = trimmed;
  sEmail = sEmail.replace(/@(gmil|gmai|gamil|gmail|gimail)\.(com?|co|con|c0m|clm)\b/i, "@gmail.com");
  sEmail = sEmail.replace(/@(hotmail|hotmai|hormail)\.(com?|co|con|c0m)\b/i, "@hotmail.com");
  sEmail = sEmail.replace(/@(yahoo)\.(com?|co|con|c0m)\b/i, "@yahoo.com");
  sEmail = sEmail.replace(/@(outlook)\.(com?|co|con|c0m)\b/i, "@outlook.com");
  if (!sEmail.includes("@")) {
    sEmail = sEmail.replace(/\s*(gmail\.com|hotmail\.com|yahoo\.com|outlook\.com)/i, "@$1");
  }
  sEmail = sEmail.replace(/@@+/, "@");

  const extract = {};
  const mPhone = trimmed.match(PHONE_RE); if (mPhone) extract.telefono = mPhone[1].replace(/[\s\-]/g, "");
  const mEmail = sEmail.match(EMAIL_RE); if (mEmail) extract.correo = mEmail[0].toLowerCase();
  const mName = trimmed.match(NAME_RE); if (mName) extract.nombre = (mName[1] || mName[2]).trim();
  const mLocation = trimmed.match(LOCATION_RE); if (mLocation) extract.ubicacion = mLocation[0];

  // Interceptar solicitud de apellido si ya dio el primer nombre pero no el apellido
  const history = session.history || [];
  const lastAssisMsg = [...history].reverse().find(m => m.role === "assistant");
  if (lastAssisMsg && /apellido/.test(lastAssisMsg.content.toLowerCase()) && session.data.nombre && !session.data.nombre.includes(" ")) {
    const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+$/;
    if (soloLetras.test(trimmed) && trimmed.length >= 2 && trimmed.length <= 30) {
      session.data.nombre = capitalize(session.data.nombre + " " + trimmed);
    }
  }

  if (session.conflict) {
    const field = session.conflict.field;
    if (/\b(s[ií]|nuevo|este|correcto|ese|primero|segundo|viejo|anterior|es|el)\b/i.test(trimmed) || (extract[field] && extract[field].toLowerCase() === session.data[field].toLowerCase())) {
      if (extract[field]) {
        session.data[field] = extract[field];
        if (field === 'correo') session.emailUpdated = true;
      }
      session.conflict = null;
    }
  }

  let caughtConflict = null;
  for (const key of ['telefono', 'correo', 'ubicacion', 'nombre']) {
    if (extract[key] && session.data[key] && session.data[key].toLowerCase() !== extract[key].toLowerCase()) {
      if (isUpdate || (session.conflict && session.conflict.field === key && /\b(s[ií]|nuevo|este|correcto|ese)\b/i.test(trimmed))) {
        session.data[key] = extract[key];
        if (key === 'correo') session.emailUpdated = true;
        session.conflict = null;
      } else if (!session.conflict) {
        caughtConflict = { field: key, old: session.data[key], new: extract[key] };
      }
    }
  }

  if (caughtConflict && !session.conflict) session.conflict = caughtConflict;

  extractData(sEmail !== trimmed ? sEmail : trimmed, session);

  const TECH_RE = /\b(caida|voltaje|tension|amper|kva|kw|cable|awg|resistencia|circuito|calculo|norma|nema|carga|potencia|transformador|breaker|interruptor|tierra|neutro|fase|trifasico|bifasico)\b/i;
  if (TECH_RE.test(trimmed) && trimmed.includes("?") && session.techQuestions < 2)
    session.techQuestions++;

  const systemPrompt = buildPrompt(session.data, session, session.techQuestions);
  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history.slice(-10),
    { role: "user", content: trimmed },
  ];

  try {
    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      max_output_tokens: 150,
      temperature: 0.35,
      input: messages,
    });

    const reply = (
      response.output_text ??
      response.output?.find(b => b.type === "message")?.content?.find(c => c.type === "output_text")?.text ??
      response.output?.[0]?.content?.[0]?.text ??
      ""
    ).trim();

    if (!reply) throw new Error("Respuesta vacía de OpenAI");

    session.history.push({ role: "user", content: trimmed });
    session.history.push({ role: "assistant", content: reply });

    let leadJustSent = false;
    if (!session.leadSent && isLeadComplete(session.data)) {
      session.leadSent = true;
      leadJustSent = true;
      console.log("📦 Lead completo:", JSON.stringify(session.data));
      Promise.all([
        sendLeadEmail(session.data, session.data.tipo, session.history)
          .then(() => console.log("✅ Email QUATRIC enviado"))
          .catch(e => console.error("❌ Email QUATRIC:", e.message)),
        sendConfirmationEmail(session.data)
          .then(() => console.log("✅ Email cliente enviado"))
          .catch(e => console.error("❌ Email cliente:", e.message)),
      ]);
      saveLeadToFile(session.data);
    } else if (session.leadSent && session.emailUpdated) {
      session.emailUpdated = false;
      console.log("🔄 Correo actualizado, reenviando leads:", session.data.correo);
      Promise.all([
        sendLeadEmail(session.data, session.data.tipo + " (ACTUALIZACIÓN CORREO)", session.history)
          .catch(e => console.error("❌ Email QUATRIC Update:", e.message)),
        sendConfirmationEmail(session.data)
          .catch(e => console.error("❌ Email cliente Update:", e.message)),
      ]);
      saveLeadToFile(session.data);
    }

    res.json({
      reply,
      meta: {
        tipo: session.data.tipo,
        leadSent: session.leadSent,
        leadJustSent,
        collected: Object.fromEntries(Object.entries(session.data).filter(([, v]) => v !== null)),
      },
    });

  } catch (err) {
    console.error("[QUATRIC] Chat error:", err.message);
    res.status(500).json({ error: "Error al procesar. Intenta de nuevo." });
  }
});

app.get("/health", (_, res) => res.json({
  status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()) + "s",
}));

app.get("/test-email", async (_, res) => {
  try {
    await resend.emails.send({
      from: "QUATRIC Chatbot <proyectos@quatricsv.com>",
      to: process.env.LEAD_EMAIL || "proyectos@quatricsv.com",
      subject: "✅ Test chatbot QUATRIC v2.1",
      html: "<p>Email funcionando correctamente — QUATRIC Chatbot v2.2 via Resend</p>",
    });
    res.json({ status: "ok", message: "Correo enviado" });
  } catch (err) {
    console.error("[QUATRIC] test-email:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 QUATRIC Chat Server v2.2 → http://localhost:${PORT}`));
