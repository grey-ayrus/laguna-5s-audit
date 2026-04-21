import express from 'express';
import {
  createAudit,
  getAllAudits,
  getAuditById,
  getAuditStats,
  downloadAuditPDF,
  deleteAudit,
  listZones,
  getZoneHistory,
} from '../controllers/auditController.js';

const router = express.Router();

router.get('/zones', listZones);
router.get('/zones/:zoneId/history', getZoneHistory);
router.get('/stats', getAuditStats);
router.post('/', createAudit);
router.get('/', getAllAudits);
router.get('/:id/pdf', downloadAuditPDF);
router.get('/:id', getAuditById);
router.delete('/:id', deleteAudit);

export default router;
