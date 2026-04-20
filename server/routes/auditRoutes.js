import express from 'express';
import {
  createAudit,
  getAllAudits,
  getAuditById,
  getAuditStats,
  downloadAuditPDF,
  deleteAudit,
  listZones,
} from '../controllers/auditController.js';

const router = express.Router();

router.get('/zones', listZones);
router.get('/stats', getAuditStats);
router.post('/', createAudit);
router.get('/', getAllAudits);
router.get('/:id/pdf', downloadAuditPDF);
router.get('/:id', getAuditById);
router.delete('/:id', deleteAudit);

export default router;
