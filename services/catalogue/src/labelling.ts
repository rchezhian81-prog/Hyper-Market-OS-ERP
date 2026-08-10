// API-02 Catalogue labelling — the unit sale price a shelf/pack label must show (roadmap v2.1 B3,
// Legal Metrology). A stateless read over the tested `unitSalePrice` engine: given an MRP, a net
// quantity and its unit, it returns the price per standard unit (₹/kg, ₹/l or ₹/piece) and whether the
// small-package / low-value exemption applies. It folds no ledger, so it needs no deps and no store.
// Gated on `catalogue.pack.read` — the same permission that reads the catalogue the label is printed
// from (owner / manager / cashier), not a finance permission: this is product-label data, not accounts.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { unitSalePrice, validateLabelHeight, InvalidUnitPriceInput, InvalidLabelHeightInput, type NetQuantityUnit } from '../../../packages/product/src/index';

const isIntString = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);
// A positive decimal (e.g. a 1.5 mm height or a 62.5 cm² panel).
const isPosNumString = (s: unknown): s is string => typeof s === 'string' && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
const UNITS: readonly NetQuantityUnit[] = ['g', 'kg', 'ml', 'l', 'unit', 'piece'];

export function labellingRoutes(): readonly Route[] {
  return [
    {
      // The unit sale price for a pre-packed commodity.
      // ?mrpMinor=&netQuantity=&unit=g|kg|ml|l|unit|piece&principalPanelAreaCm2=
      api: 'API-02', method: 'GET', path: '/v1/catalogue/unit-price',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const mrp = ctx.query['mrpMinor'];
        const qty = ctx.query['netQuantity'];
        const unit = ctx.query['unit'];
        const panel = ctx.query['principalPanelAreaCm2'];
        if (!isIntString(mrp) || !isIntString(qty) || typeof unit !== 'string' || !UNITS.includes(unit as NetQuantityUnit)) {
          throw apiError(400, {
            code: 'unit_price_needs_figures',
            whatHappened: 'The unit sale price needs ?mrpMinor=<whole paisa>, ?netQuantity=<whole number> and ?unit=g|kg|ml|l|unit|piece.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the MRP, net quantity and unit. A label reads, it never writes.',
          });
        }
        if (panel !== undefined && !isIntString(panel)) {
          throw apiError(400, { code: 'unit_price_panel_invalid', whatHappened: '?principalPanelAreaCm2=, if given, must be a whole number of square centimetres.', wasItSaved: 'not_saved', nextSafeAction: 'Send a whole panel area or omit it.' });
        }
        try {
          const result = unitSalePrice({
            mrpMinor: Number(mrp), netQuantity: Number(qty), unit: unit as NetQuantityUnit,
            ...(panel === undefined ? {} : { principalPanelAreaCm2: Number(panel) }),
          });
          return { status: 200, body: result };
        } catch (err) {
          if (err instanceof InvalidUnitPriceInput) throw apiError(400, { code: 'unit_price_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the MRP or net quantity.' });
          throw err;
        }
      },
    },
    {
      // The minimum statutory character height for a declaration, and whether a self-printed template
      // meets it (B24, Legal Metrology Rule 9). A too-small height is a non-compliant label.
      // ?principalPanelAreaCm2=&declaredHeightMm=
      api: 'API-02', method: 'GET', path: '/v1/catalogue/label-height',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const area = ctx.query['principalPanelAreaCm2'];
        const height = ctx.query['declaredHeightMm'];
        if (!isPosNumString(area) || !isPosNumString(height)) {
          throw apiError(400, {
            code: 'label_height_needs_figures',
            whatHappened: 'A label-height check needs ?principalPanelAreaCm2=<positive> and ?declaredHeightMm=<positive> (mm).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the panel area and the printed character height.',
          });
        }
        try {
          return { status: 200, body: validateLabelHeight({ principalPanelAreaCm2: Number(area), declaredHeightMm: Number(height) }) };
        } catch (err) {
          if (err instanceof InvalidLabelHeightInput) throw apiError(400, { code: 'label_height_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the panel area or the height.' });
          throw err;
        }
      },
    },
  ];
}
