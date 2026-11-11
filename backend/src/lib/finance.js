// Utilidades financieras compartidas (cálculo de mora, estados, edades de cartera).

// Días calendario entre dos fechas (fecha de vencimiento -> hoy).
export function diasEntre(desde, hasta) {
  const a = new Date(desde);
  const b = new Date(hasta);
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Interés de mora sobre un saldo vencido.
// tasaMensual viene de la copropiedad (ej. 0.02 = 2% mensual).
// diasGracia: días de tolerancia antes de liquidar mora (ej. 5 días).
export function calcularInteresMora(saldo, diasMora, tasaMensual, diasGracia = 0) {
  const s = Number(saldo);
  const t = Number(tasaMensual);
  
  // Si está dentro de los días de gracia o sin saldo/días, no cobra mora
  if (diasMora <= diasGracia || s <= 0 || t <= 0) return 0;
  
  // Tasa diaria proporcional (base comercial 30 días)
  const tasaDiaria = t / 30;
  const interes = s * tasaDiaria * diasMora;
  return Math.round(interes);
}

// Determina el estado de una factura a partir de su saldo.
export function estadoPorSaldo(total, saldo, estadoActual) {
  if (estadoActual === "Anulada") return "Anulada";
  if (saldo === 0) return "Pagada";
  if (saldo < total) return "Parcialmente pagada";
  return "Pendiente";
}

// ¿La factura está en mora a la fecha indicada considerando días de gracia?
export function estaEnMora(fechaVencimiento, hoy = new Date(), diasGracia = 0) {
  const dias = diasEntre(fechaVencimiento, hoy);
  return dias > diasGracia;
}