'use strict';

/**
 * face-queue controller (v5). Custom endpoints ported from v3
 * api/face-queue/controllers/face-queue.js (verifySetup / checkStatus);
 * core CRUD inherited from createCoreController.
 */

const fs = require('fs');
const path = require('path');

const { createCoreController } = require('@strapi/strapi').factories;

const FACE_QUEUE_UID = 'api::face-queue.face-queue';
const CONTACT_UID = 'api::contact.contact';
const ME_UID = 'api::me.me';

module.exports = createCoreController(FACE_QUEUE_UID, ({ strapi }) => ({
  /**
   * Verify FACe configuration for this installation
   * GET /api/face-queues/verify-setup
   */
  async verifySetup(ctx) {
    const me = await strapi.documents(ME_UID).findFirst();
    const checks = {
      overall: true,
      details: {}
    };

    // Check 1: FACe enabled
    checks.details.face_enabled = {
      status: me.face && me.face !== "no",
      value: me.face || "no",
      message: me.face && me.face !== "no"
        ? "✅ FACe is enabled"
        : "❌ FACe is disabled (set to 'test' or 'real')"
    };

    // Check 2: Certificate uploaded
    checks.details.certificate = {
      status: !!(me.face_certificate && me.face_certificate.url),
      value: me.face_certificate ? me.face_certificate.name || me.face_certificate.url : null,
      message: me.face_certificate && me.face_certificate.url
        ? "✅ Certificate uploaded"
        : "❌ Certificate not uploaded"
    };

    // Check 3: Certificate password configured
    checks.details.certificate_password = {
      status: !!me.face_certificate_password,
      value: me.face_certificate_password ? "[configured]" : null,
      message: me.face_certificate_password
        ? "✅ Certificate password configured"
        : "❌ Certificate password not set"
    };

    // Check 4: Endpoints configured
    const testEndpoint = me.face_test_endpoint || null;
    const realEndpoint = me.face_real_endpoint || "https://api.face.gob.es/providers";

    checks.details.endpoints = {
      status: !!realEndpoint,
      value: {
        test: testEndpoint,
        real: realEndpoint
      },
      message: realEndpoint
        ? "✅ Production endpoint configured"
        : "❌ Endpoints not configured"
    };

    // Check 5: Certificate file exists
    if (me.face_certificate && me.face_certificate.url) {
      const certificateRelativePath = me.face_certificate.url.replace(/^\//, "");
      const certificatePath = path.join(
        strapi.dirs.static.public,
        certificateRelativePath
      );
      const certificateExists = fs.existsSync(certificatePath);

      checks.details.certificate_file = {
        status: certificateExists,
        value: certificatePath,
        message: certificateExists
          ? "✅ Certificate file exists on disk"
          : "❌ Certificate file not found on disk"
      };
    } else {
      checks.details.certificate_file = {
        status: false,
        value: null,
        message: "❌ Certificate not uploaded, cannot check file"
      };
    }

    // Check 6: Organization NIF
    checks.details.organization_nif = {
      status: !!me.nif,
      value: me.nif || null,
      message: me.nif
        ? "✅ Organization NIF configured"
        : "❌ Organization NIF not set"
    };

    // Check 7: At least one FACe-enabled contact with DIR3
    const faceContacts = await strapi.db.query(CONTACT_UID).findMany({
      where: { face: true },
      limit: 5,
    });

    const contactsWithDir3 = faceContacts.filter(c =>
      c.face_dir3_oc && c.face_dir3_og && c.face_dir3_ut
    );

    checks.details.face_contacts = {
      status: contactsWithDir3.length > 0,
      value: {
        total: faceContacts.length,
        with_dir3: contactsWithDir3.length
      },
      message: contactsWithDir3.length > 0
        ? `✅ ${contactsWithDir3.length} contact(s) with FACe and DIR3 codes`
        : faceContacts.length > 0
          ? `⚠️ ${faceContacts.length} FACe contact(s) but missing DIR3 codes`
          : "❌ No FACe-enabled contacts"
    };

    // Check 8: Environment variable
    checks.details.dry_run_mode = {
      status: process.env.FACE_DRY_RUN !== "true",
      value: process.env.FACE_DRY_RUN || "false",
      message: process.env.FACE_DRY_RUN === "true"
        ? "⚠️ DRY-RUN mode enabled (no invoices will be sent)"
        : "✅ DRY-RUN mode disabled (invoices will be sent)"
    };

    // Overall status
    checks.overall = Object.values(checks.details)
      .filter(c => c.status !== undefined)
      .every(c => c.status === true ||
        (c === checks.details.face_contacts && c.status === false) // Allow missing contacts
      );

    // Summary
    checks.summary = {
      ready_for_production: checks.overall &&
        checks.details.face_enabled.status &&
        checks.details.face_enabled.value === "real" &&
        checks.details.face_contacts.status,
      ready_for_testing: checks.overall &&
        checks.details.dry_run_mode.value === "true",
      missing_steps: Object.entries(checks.details)
        .filter(([key, check]) => !check.status && key !== "face_contacts")
        .map(([key]) => key)
    };

    return ctx.send(checks);
  },

  /**
   * Check status of a face-queue item
   * GET /api/face-queues/:id/check-status
   */
  async checkStatus(ctx) {
    const { id } = ctx.params;

    try {
      const faceQueue = await strapi.db.query(FACE_QUEUE_UID).findOne({ where: { id } });

      if (!faceQueue) {
        return ctx.notFound("Face queue not found");
      }

      if (!faceQueue.registration_number) {
        return ctx.badRequest("No registration number available for this invoice");
      }

      const me = await strapi.documents(ME_UID).findFirst();

      if (!me.face || me.face === "no") {
        return ctx.badRequest("FACe is not enabled");
      }

      const service = strapi.service('api::face-queue.face-queue');
      const statusResult = await service.checkInvoiceStatus({
        registrationNumber: faceQueue.registration_number,
        mode: faceQueue.mode,
        me,
      });

      if (statusResult.success) {
        // Map FACe status to our internal status
        const estado = statusResult.estado || statusResult.codigoEstado;
        let newStatus = "registered";
        if (estado === "REC01" || estado === "delivered" || estado === "entregada") {
          newStatus = "delivered";
        } else if (estado === "REC02" || estado === "rejected" || estado === "rechazada") {
          newStatus = "rejected";
        }

        await strapi.db.query(FACE_QUEUE_UID).update({
          where: { id: faceQueue.id },
          data: {
            status: newStatus,
            response_body: JSON.stringify(statusResult.data, null, 2),
            last_status_check: new Date(),
          },
        });

        return ctx.send({
          success: true,
          status: newStatus,
          estado: statusResult.estado,
          codigoEstado: statusResult.codigoEstado,
          motivoRechazo: statusResult.motivoRechazo,
          data: statusResult.data,
        });
      } else {
        return ctx.send({
          success: false,
          error: statusResult.error,
        }, statusResult.statusCode || 500);
      }
    } catch (error) {
      strapi.log.error("[face-queue] checkStatus error:", error);
      return ctx.badRequest(error.message);
    }
  },
}));
