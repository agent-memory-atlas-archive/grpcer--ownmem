/**
 * Instrumentation self-checks find scalar fields that look measured but remain constant and
 * declared producers that never emit. Consumer-only fixtures cannot prove that a production
 * path can produce more than its placeholder value, so sufficient real samples with one scalar
 * value raise a warning. The warning expires automatically once the producer varies. Legitimate
 * constants exist, so these findings never become hard failures by themselves.
 *
 * A constant that is constant by contract is declared in EXPLAINED_CONSTANT_FIELDS and reported in
 * its own register. It is stated rather than suppressed: a reader who sees only "zero variance" on
 * a field no producer can vary tends to make it vary by inventing a value, which is the exact
 * failure this file exists to catch.
 */

import { MEMORY_RECALL_COMPONENTS } from './memory-observability.mjs';

// Register every event-producing component so a path that never runs remains observable.
// Recall degradation components expand from their shared registry to avoid duplicate inventories.
export const EXPECTED_MEMORY_COMPONENTS = Object.freeze([
  'memory-attribution',
  'memory-audit',
  'memory-compile',
  'memory-hook',
  'memory-observe',
  'memory-outcome',
  'memory-read',
  'memory-recall-cli',
  ...MEMORY_RECALL_COMPONENTS,
].sort((left, right) => left.localeCompare(right, 'en')));

/**
 * Producers that were deleted. Historical rows may still name them; they are not a prompt to add
 * the name back to EXPECTED_MEMORY_COMPONENTS, and they are not a live signal.
 */
export const RETIRED_MEMORY_COMPONENTS = Object.freeze([
  'memory-evolution',
  // Shell reads are written by memory-read and now say so; where they were collected moved to
  // `via: 'shell'`. Rows from before that still name this component until retention drops them.
  'memory-shell-read',
]);
export const RETIRED_EVENT_TYPES = Object.freeze([
  'evolution.completed',
  'maintenance.completed',
  // Retired in 2.0 with the hooks that wrote them: no report, metric or gate ever read one.
  'command.completed',
  'correction.observed',
  'external.context.observed',
]);

/**
 * Payload fields whose producer was removed while the event type lives on. The schema still
 * accepts them so earlier rows validate, and those rows keep carrying the one value the dead
 * producer wrote. That is history, not a placeholder: no code can vary it any more, and the fix
 * for the finding would be to write the field again. Keyed as `<event>.<field>`, reported in
 * their own register with the reason, and dropped from the register once retention has removed
 * the last row that carries them.
 */
export const RETIRED_PAYLOAD_FIELDS = Object.freeze({
  'recall.consumed.authority_followed':
    'removed in 0.8.0 because no producer could observe whether authority documents were opened; rows written before 2026-09-30 still carry null',
});

/**
 * Fields whose single value is the designed answer, not a placeholder. They are still printed, with
 * the reason, because hiding them is how the next reader "fixes" one back into a lie: writing
 * `cache_hit: false` would claim a measurement that no production path performs. A field belongs
 * here only when a second value is impossible -- a schema `const`, or a producer that has no branch
 * that could emit one. A field that merely has not varied yet stays a finding.
 */
export const EXPLAINED_CONSTANT_FIELDS = Object.freeze({
  'recall.completed.cache_hit':
    'production recall has no result cache, so null is the honest value; a false here would report a measured miss',
  'trust.quarantined.use_time_revalidation':
    'the event schema pins this to const true, so variance is impossible by contract',
  'attribution.recorded.basis':
    'the event schema pins this to const "self-attribution", so variance is impossible by contract',
  'attribution.recorded.scope':
    'the event schema pins this to const "turn", so variance is impossible by contract',
  'recall.completed.dropped_topics':
    'it counts min(eligible, maxTopics) - results.length, and the default tier caps topics at 1, so it is 0 whether one candidate qualified or nine; "how many did the cap turn away" is answered by delivery.eligible instead',
});

/**
 * Components whose silence is the healthy reading, not a dead path. Each has a producer with one
 * branch that emits only when something went wrong or someone acted, and the report already measures
 * that condition through a different event. They are stated in their own register rather than
 * removed from EXPECTED_MEMORY_COMPONENTS, because the source-scan guard in the self-test still has
 * to prove the producer exists, and a reader still has to see that the path did not run this window.
 * A component is not declared here merely because it has not emitted yet.
 */
export const EXPLAINED_IDLE_COMPONENTS = Object.freeze({
  'memory-outcome':
    'it writes only when a user or the host confirms an outcome receipt; the report states that receipt count, so no event here is the absent sample, not a path that cannot run',
  'memory-recall-previous':
    'it emits only when recall falls back to the previous snapshot; the report measures that as the snapshot degradation rate, so no event here means the current snapshot served every recall',
});

export const DEFAULT_CONSTANT_FIELD_MINIMUM_SAMPLES = 30;

function isScalar(value) {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value);
}

/**
 * Find scalar payload fields with only one value across at least minimumSamples rows that carry
 * the field. The sample count is the field's own, not the event type's: a field present on 44 of
 * 130 rows has 44 samples, and reporting 130 overstated how much evidence stood behind the finding.
 */
export function detectConstantPayloadFields(events, {
  minimumSamples = DEFAULT_CONSTANT_FIELD_MINIMUM_SAMPLES,
  ignore = [],
} = {}) {
  const ignored = new Set(ignore);
  const byEvent = new Map();
  for (const event of events) {
    let fields = byEvent.get(event.event);
    if (!fields) {
      fields = new Map();
      byEvent.set(event.event, fields);
    }
    for (const [key, value] of Object.entries(event.payload || {})) {
      if (!isScalar(value)) continue;
      let seen = fields.get(key);
      if (!seen) {
        seen = { samples: 0, values: new Set() };
        fields.set(key, seen);
      }
      seen.samples += 1;
      // Once a second value appears the field is not constant; stop retaining more values.
      if (seen.values.size <= 1) seen.values.add(JSON.stringify(value));
    }
  }

  const findings = [];
  for (const [eventName, fields] of byEvent) {
    for (const [field, seen] of fields) {
      const anchor = `${eventName}.${field}`;
      if (seen.samples < minimumSamples || seen.values.size !== 1 || ignored.has(anchor)) continue;
      findings.push({ event: eventName, field, anchor, value: JSON.parse([...seen.values][0]), samples: seen.samples });
    }
  }
  return findings.sort((left, right) => left.anchor.localeCompare(right.anchor, 'en'));
}

/** Return declared event producers absent from the observed event batch. */
export function detectSilentComponents(events, { expected = EXPECTED_MEMORY_COMPONENTS } = {}) {
  const observed = new Set(events.map((event) => event.process?.component).filter(Boolean));
  return {
    observed: [...observed].sort((left, right) => left.localeCompare(right, 'en')),
    silent: expected.filter((component) => !observed.has(component)),
    unexpected: [...observed].filter((component) => !expected.includes(component))
      .sort((left, right) => left.localeCompare(right, 'en')),
  };
}

export function collectInstrumentationHealth(events, options = {}) {
  const explained = options.explained ?? EXPLAINED_CONSTANT_FIELDS;
  const retiredFields = options.retiredFields ?? RETIRED_PAYLOAD_FIELDS;
  const explainedIdle = options.explainedIdle ?? EXPLAINED_IDLE_COMPONENTS;
  const liveEvents = events.filter((event) => !RETIRED_EVENT_TYPES.includes(event.event));
  const detected = detectConstantPayloadFields(liveEvents, options);
  const constantFields = detected.filter((item) => !(item.anchor in explained) && !(item.anchor in retiredFields));
  const explainedFields = detected
    .filter((item) => item.anchor in explained)
    .map((item) => ({ ...item, reason: explained[item.anchor] }));
  const retiredFieldsPresent = detected
    .filter((item) => item.anchor in retiredFields)
    .map((item) => ({ ...item, reason: retiredFields[item.anchor] }));
  const components = detectSilentComponents(liveEvents, options);
  const unexpected = components.unexpected.filter((component) => !RETIRED_MEMORY_COMPONENTS.includes(component));
  return {
    samples: liveEvents.length,
    minimum_samples: options.minimumSamples ?? DEFAULT_CONSTANT_FIELD_MINIMUM_SAMPLES,
    constant_fields: constantFields,
    explained_constant_fields: explainedFields,
    retired_fields_present: retiredFieldsPresent,
    observed_components: components.observed.filter((component) => !RETIRED_MEMORY_COMPONENTS.includes(component)),
    silent_components: components.silent.filter((component) => !(component in explainedIdle)),
    explained_idle_components: components.silent
      .filter((component) => component in explainedIdle)
      .map((component) => ({ component, reason: explainedIdle[component] })),
    unexpected_components: unexpected,
  };
}

export function formatInstrumentationHealth(health) {
  if (health.samples === 0) return 'Instrumentation health: no event samples, so it cannot tell whether a field is only a placeholder.';
  const lines = [];
  if (health.constant_fields.length > 0) {
    lines.push(`Instrumentation health: ${health.constant_fields.length} field(s) with zero variance (a placeholder, or the producer is broken)`);
    for (const item of health.constant_fields) {
      lines.push(`  ${item.anchor} is always ${JSON.stringify(item.value)} (${item.samples} sample(s))`);
    }
  }
  if (health.explained_constant_fields?.length > 0) {
    lines.push(`Instrumentation health: ${health.explained_constant_fields.length} field(s) constant by design (stated, not a finding)`);
    for (const item of health.explained_constant_fields) {
      lines.push(`  ${item.anchor} is always ${JSON.stringify(item.value)} -- ${item.reason}`);
    }
  }
  if (health.retired_fields_present?.length > 0) {
    lines.push(`Instrumentation health: ${health.retired_fields_present.length} retired field(s) still present on historical rows (stated, not a finding)`);
    for (const item of health.retired_fields_present) {
      lines.push(`  ${item.anchor} is always ${JSON.stringify(item.value)} on ${item.samples} row(s) -- ${item.reason}`);
    }
  }
  if (health.silent_components.length > 0) {
    lines.push(`Instrumentation health: ${health.silent_components.length} component(s) never emitted an event (the code path may never actually run)`);
    for (const component of health.silent_components) lines.push(`  ${component}`);
  }
  if (health.explained_idle_components?.length > 0) {
    lines.push(`Instrumentation health: ${health.explained_idle_components.length} component(s) idle by design this window (stated, not a finding)`);
    for (const item of health.explained_idle_components) lines.push(`  ${item.component} -- ${item.reason}`);
  }
  if (health.unexpected_components.length > 0) {
    lines.push(`Instrumentation health: ${health.unexpected_components.length} component(s) are not on the expected list; update EXPECTED_MEMORY_COMPONENTS`);
    for (const component of health.unexpected_components) lines.push(`  ${component}`);
  }
  return lines.length === 0
    ? `Instrumentation health: ${health.samples} sample(s), no zero-variance fields, every expected component emitted events.`
    : lines.join('\n');
}
