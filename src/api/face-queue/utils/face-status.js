'use strict';

/**
 * Our status from a FACe status answer. FACe's REST API gives `status` (text)
 * and `statusHistory` (codes): 1200 Registrada, 1300 Registrada en RCF,
 * 2400 Contabilizada, 2500 Pagada, 2600 Rechazada, 3100 Anulada. The codes
 * only grow, so the highest one is the current status.
 * A string is still accepted (the old `estado` values).
 */
const mapFaceEstado = (answer) => {
  const data = answer && typeof answer === "object" ? answer : { status: answer };
  const codes = (Array.isArray(data.statusHistory) ? data.statusHistory : [])
    .map((entry) => Number(entry && entry.code))
    .filter((code) => Number.isFinite(code));
  const code = codes.length ? Math.max(...codes) : Number(data.code || data.codigo_estado);
  const text = String(data.status || data.estado || "").toLowerCase();

  if (code === 2600 || code === 3100 || ["rec02", "rejected", "rechazada", "anulada"].includes(text)) {
    return "rejected";
  }
  if (code === 2400 || code === 2500 || ["rec01", "delivered", "entregada", "pagada"].includes(text) || text.startsWith("contabilizada")) {
    return "delivered";
  }
  return "registered";
};

/**
 * The FACe registry number of a queue row. Rows sent before it was read from
 * `registryCode` have it only in the saved FACe answer.
 */
const registrationNumberOf = (queue) => {
  if (!queue) return null;
  if (queue.registration_number) return queue.registration_number;
  try {
    const body = typeof queue.response_body === "string" ? JSON.parse(queue.response_body) : queue.response_body;
    return (body && typeof body === "object" && body.registryCode) || null;
  } catch (e) {
    return null;
  }
};

module.exports = { mapFaceEstado, registrationNumberOf };
