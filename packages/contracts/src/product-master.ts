import { z } from 'zod';

const uuid = z.uuid();
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);
const label = z.string().trim().min(1).max(200);
export const productLifecycle = z.enum(['draft', 'active', 'discontinued']);
export const productTaxonGroup = key;
export const productEvidenceLevel = z.enum([
  'exact_primary',
  'component_primary',
  'equivalent_market',
  'disclosure_by_code',
  'name_only',
  'pending',
]);
const scope = z
  .object({ kind: z.enum(['tenant', 'market', 'source']), key })
  .strict()
  .refine((value) => value.kind !== 'tenant' || value.key === 'global');
const taxonRef = z
  .object({ group: productTaxonGroup, slug: key })
  .strict()
  .refine((value) => value.group !== 'unit');
const observation = z
  .object({
    sourceSystem: z.enum(['HYCITE', 'INCITE', 'DOCUCITE', 'RPT_USER', 'IMPORT', 'API']),
    sourceReference: z.string().trim().min(1).max(500),
    externalId: z.string().trim().min(1).max(160),
    observedAt: z.iso.datetime({ offset: true }),
    authorityLevel: z.enum(['official', 'verified', 'authorized', 'import', 'manual']),
    scope,
  })
  .strict();
const evidence = z
  .object({
    observation,
    evidenceLevel: productEvidenceLevel,
    sourceLiteral: z.string().trim().min(1).max(1000),
  })
  .strict();

export const productCreate = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: uuid,
    stableKey: key,
    name: label,
    lifecycle: productLifecycle,
  })
  .strict();
export type ProductCreate = z.infer<typeof productCreate>;

const fact = z
  .object({
    nodeId: uuid,
    factKind: z.enum([
      'material',
      'composition',
      'construction',
      'technology',
      'function',
      'capacity',
      'dimension',
      'compatibility',
      'care',
      'certification',
      'disclosure',
    ]),
    valueKind: z.enum(['text', 'decimal', 'taxon']),
    valueText: z.string().trim().min(1).max(1000).nullable().default(null),
    valueDecimal: z
      .string()
      .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
      .nullable()
      .default(null),
    unitSlug: key.nullable().default(null),
    taxon: taxonRef.nullable().default(null),
    previousFactId: uuid.nullable().default(null),
    evidence,
  })
  .strict()
  .superRefine((value, context) => {
    const hasValue =
      value.valueText !== null || value.valueDecimal !== null || value.taxon !== null;
    if (
      ['pending', 'name_only'].includes(value.evidence.evidenceLevel) &&
      (hasValue || value.unitSlug !== null)
    )
      context.addIssue({
        code: 'custom',
        message: 'unconfirmed evidence cannot have a normalized value',
      });
    if (
      !['pending', 'name_only'].includes(value.evidence.evidenceLevel) &&
      ((value.valueKind === 'text' &&
        (value.valueText === null ||
          value.valueDecimal !== null ||
          value.unitSlug !== null ||
          value.taxon !== null)) ||
        (value.valueKind === 'decimal' &&
          (value.valueDecimal === null ||
            value.unitSlug === null ||
            value.valueText !== null ||
            value.taxon !== null)) ||
        (value.valueKind === 'taxon' &&
          (value.taxon === null ||
            value.valueText !== null ||
            value.valueDecimal !== null ||
            value.unitSlug !== null)))
    )
      context.addIssue({ code: 'custom', message: 'normalized value does not match value kind' });
    if (value.valueKind === 'taxon' && value.taxon && value.taxon.group !== value.factKind)
      context.addIssue({ code: 'custom', message: 'taxon group must match technical fact kind' });
  });

export const productCommand = z
  .object({
    schemaVersion: z.literal(1),
    expectedVersion: z.number().int().positive(),
    command: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('create_model'),
          stableKey: key,
          name: label,
          lifecycle: productLifecycle,
        })
        .strict(),
      z
        .object({ type: z.literal('create_variant'), modelId: uuid, stableKey: key, name: label })
        .strict(),
      z
        .object({ type: z.literal('set_lifecycle'), nodeId: uuid, lifecycle: productLifecycle })
        .strict(),
      z.object({ type: z.literal('define_group'), slug: productTaxonGroup, label }).strict(),
      z
        .object({ type: z.literal('define_taxon'), group: productTaxonGroup, slug: key, label })
        .strict(),
      z
        .object({
          type: z.literal('assign_taxon'),
          nodeId: uuid,
          group: productTaxonGroup,
          slug: key,
        })
        .strict(),
      z
        .object({
          type: z.literal('assign_code'),
          nodeId: uuid,
          codeKind: z.enum(['sku', 'model', 'market', 'source']),
          scope,
          code: z.string().trim().min(1).max(100),
        })
        .strict(),
      z.object({ type: z.literal('record_fact'), fact }).strict(),
      z
        .object({
          type: z.literal('relate'),
          fromNodeId: uuid,
          toNodeId: uuid,
          relationKind: z.enum([
            'contains',
            'component_of',
            'accessory_for',
            'compatible_with',
            'replacement_for',
            'supersedes',
            'equivalent_to',
            'related_to',
          ]),
          evidence: evidence.extend({
            evidenceLevel: productEvidenceLevel.exclude(['pending', 'name_only']),
          }),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const evidence =
      value.command.type === 'record_fact'
        ? value.command.fact.evidence
        : value.command.type === 'relate'
          ? value.command.evidence
          : null;
    if (
      evidence &&
      !['pending', 'name_only'].includes(evidence.evidenceLevel) &&
      !['official', 'verified'].includes(evidence.observation.authorityLevel)
    )
      context.addIssue({
        code: 'custom',
        message: 'confirmed technical facts require primary or verified source authority',
      });
  });
export type ProductCommand = z.infer<typeof productCommand>;

export const productListQuery = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    afterId: uuid.nullable().default(null),
  })
  .strict();
export type ProductListQuery = z.infer<typeof productListQuery>;
