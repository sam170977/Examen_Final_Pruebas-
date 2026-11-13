import { Router } from "express";
import { query, pool } from "../lib/db.js";
import { authRequired, condominioDeLaPeticion, requireRol } from "../lib/auth.js";

const router = Router();
router.use(authRequired);

const FECHA_EMISION_ESCENARIO = "2026-11-10";

// Fecha de vencimiento: día 10 del mes siguiente al periodo (YYYY-MM).
function vencimientoDe(periodo) {
  const [y, m] = periodo.split("-").map(Number);
  const siguiente = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return `${siguiente}-10`;
}

// Listado de facturas de un periodo (con aislamiento para propietarios).
router.get("/", async (req, res) => {
  const condominioId = condominioDeLaPeticion(req);
  const periodo = req.query.periodo;
  const params = [condominioId];
  let sql = `SELECT f.id, f.inmueble_id, i.identificacion, f.periodo,
                    f.fecha_emision, f.fecha_vencimiento, f.total, f.saldo, f.estado
               FROM factura f JOIN inmueble i ON i.id = f.inmueble_id
              WHERE f.condominio_id = $1`;

  // DEF-03: Si el usuario es propietario, solo puede ver las facturas de sus propios inmuebles
  if (req.user.rol === "propietario") {
    params.push(req.user.persona_id || req.user.id);
    sql += ` AND i.propietario_id = $${params.length}`;
  }

  if (periodo) {
    params.push(periodo);
    sql += ` AND f.periodo = $${params.length}`;
  }
  sql += " ORDER BY i.identificacion, f.periodo";
  const { rows } = await query(sql, params);
  res.json({ facturas: rows });
});

// Facturación masiva de una cuota extraordinaria repartida por coeficiente.
router.post(
  "/masiva",
  requireRol("admin_copropiedad", "contador", "superadmin"),
  async (req, res) => {
    const condominioId = condominioDeLaPeticion(req);
    const { periodo, concepto_id } = req.body || {};
    if (!periodo || !concepto_id) {
      return res.status(400).json({ error: "periodo y concepto_id son obligatorios" });
    }

    // Validar que no exista ya facturación generada para este concepto en el mismo periodo
    const duplicada = await query(
      `SELECT 1 FROM factura f
         JOIN factura_detalle fd ON fd.factura_id = f.id
        WHERE f.condominio_id = $1 AND f.periodo = $2 AND fd.concepto_id = $3 AND f.estado <> 'Anulada'
        LIMIT 1`,
      [condominioId, periodo, concepto_id]
    );
    if (duplicada.rows.length > 0) {
      return res.status(409).json({ error: "Ya existe facturación activa para este concepto y periodo" });
    }

    const cpt = await query(
      "SELECT * FROM concepto WHERE id = $1 AND condominio_id = $2",
      [concepto_id, condominioId]
    );
    if (!cpt.rows[0]) return res.status(404).json({ error: "Concepto no encontrado" });
    const concepto = cpt.rows[0];
    const totalARepartir = Number(concepto.valor_base);

    const inms = await query(
      "SELECT id, coeficiente FROM inmueble WHERE condominio_id = $1 AND estado = 'activo' ORDER BY id",
      [condominioId]
    );

    const vencimiento = vencimientoDe(periodo);
    const client = await pool.connect();
    const creadas = [];
    try {
      await client.query("BEGIN");
      let acumulado = 0;

      for (let idx = 0; idx < inms.rows.length; idx++) {
        const inm = inms.rows[idx];
        const esUltimo = idx === inms.rows.length - 1;

        // DEF-04: Evitar descuadre por redondeo; el último inmueble absorbe la diferencia residual de centavos/pesos
        let valor = Math.round(totalARepartir * Number(inm.coeficiente));
        if (esUltimo && inms.rows.length > 0) {
          valor = Math.round(totalARepartir - acumulado);
        }
        acumulado += valor;

        const f = await client.query(
          `INSERT INTO factura (condominio_id, inmueble_id, periodo, fecha_emision,
                                fecha_vencimiento, subtotal, total, saldo, estado)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'Pendiente')
           RETURNING id, inmueble_id, total`,
          [condominioId, inm.id, periodo, FECHA_EMISION_ESCENARIO, vencimiento, valor]
        );
        await client.query(
          `INSERT INTO factura_detalle (factura_id, concepto_id, descripcion, valor)
           VALUES ($1, $2, $3, $4)`,
          [f.rows[0].id, concepto.id, concepto.nombre, valor]
        );
        creadas.push(f.rows[0]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Error generando la facturación", detalle: e.message });
    } finally {
      client.release();
    }

    const sumaFacturada = creadas.reduce((acc, f) => acc + Number(f.total), 0);
    res.status(201).json({
      concepto: concepto.nombre,
      total_a_repartir: totalARepartir,
      suma_facturada: sumaFacturada,
      facturas_generadas: creadas.length,
      facturas: creadas,
    });
  }
);

// Anular una factura (solo si no tiene pagos aplicados ni está pagada).
router.post("/:id/anular", requireRol("admin_copropiedad", "contador", "superadmin"), async (req, res) => {
  const condominioId = condominioDeLaPeticion(req);

  const actual = await query(
    "SELECT id, estado, total, saldo FROM factura WHERE id = $1 AND condominio_id = $2",
    [req.params.id, condominioId]
  );
  if (!actual.rows[0]) return res.status(404).json({ error: "Factura no encontrada" });

  const factura = actual.rows[0];
  // DEF-05: Impedir anulación de facturas pagadas o con abonos parciales
  if (factura.estado === "Pagada" || factura.estado === "Parcialmente pagada" || Number(factura.saldo) < Number(factura.total)) {
    return res.status(400).json({ error: "No se puede anular una factura que ya tiene pagos o abonos registrados" });
  }
  if (factura.estado === "Anulada") {
    return res.status(400).json({ error: "La factura ya se encuentra anulada" });
  }

  const { rows } = await query(
    "UPDATE factura SET estado = 'Anulada', saldo = 0 WHERE id = $1 AND condominio_id = $2 RETURNING id, estado",
    [req.params.id, condominioId]
  );
  res.json(rows[0]);
});

export default router;