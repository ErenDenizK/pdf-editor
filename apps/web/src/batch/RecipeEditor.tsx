/**
 * The recipe editor: name, description and the ordered steps (add, remove, move up and
 * down, and each step's options form). Saving checks the draft with `readRecipe`, whose
 * error names the step and the option at fault; nothing invalid is ever stored.
 */
import {
  describeRecipe,
  isRecipeError,
  MAX_RECIPE_STEPS,
  RECIPE_FORMAT,
  RECIPE_VERSION,
  type Recipe,
  type RecipeError,
  type RecipeStep,
  type RecipeStepKind,
  readRecipe,
} from '@pdf-editor/document-model';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { m } from '../i18n';
import tool from '../tools/ToolDialog.module.css';
import styles from './Batch.module.css';
import { recipeErrorText, stepDetail, stepKindLabel, waitingForLabel } from './labels';
import { ADDABLE_STEP_KINDS, defaultStep } from './step-defaults';
import { StepForm } from './StepForm';

export interface RecipeEditorProps {
  readonly initial: Recipe;
  readonly onSave: (recipe: Recipe) => Promise<void>;
  readonly onCancel: () => void;
}

interface DraftStep {
  /** Stable React key while steps move. */
  readonly key: number;
  readonly step: RecipeStep;
}

let keys = 0;

export function RecipeEditor({ initial, onSave, onCancel }: RecipeEditorProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    initial.steps.map((step) => ({ key: ++keys, step })),
  );
  const [open, setOpen] = useState<number | null>(null);
  const [addKind, setAddKind] = useState<RecipeStepKind>('page-numbers');
  const [error, setError] = useState<RecipeError | null>(null);
  const [saving, setSaving] = useState(false);

  const draft: Recipe = {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    name,
    ...(description.trim() === '' ? {} : { description }),
    steps: steps.map((s) => s.step),
  };
  let summary: ReturnType<typeof describeRecipe> | undefined;
  try {
    summary = describeRecipe(draft);
  } catch {
    summary = undefined;
  }

  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + by, 0, item);
    setSteps(next);
    setError(null);
  };
  const add = () => {
    const item = { key: ++keys, step: defaultStep(addKind) };
    const exportAt = steps.findIndex((s) => s.step.kind === 'export');
    // The output step stays last.
    const at = addKind === 'export' || exportAt === -1 ? steps.length : exportAt;
    const next = [...steps];
    if (addKind === 'export' && exportAt !== -1) next.splice(exportAt, 1);
    next.splice(Math.min(at, next.length), 0, item);
    setSteps(next);
    setOpen(item.key);
    setError(null);
  };
  const save = async () => {
    let checked: Recipe;
    try {
      checked = readRecipe(draft);
    } catch (caught) {
      if (isRecipeError(caught)) {
        setError(caught);
        if (caught.stepIndex !== undefined) setOpen(steps[caught.stepIndex]?.key ?? null);
        return;
      }
      throw caught;
    }
    setSaving(true);
    try {
      await onSave(checked);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className={styles.scroll} data-testid="batch-editor">
        <div className={tool.row}>
          <label className={tool.field}>
            <span className={tool.label}>{m.batch_field_name()}</span>
            <input
              className={tool.input}
              value={name}
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </label>
        </div>
        <label className={tool.field}>
          <span className={tool.label}>{m.batch_field_description()}</span>
          <input
            className={tool.input}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <section className={styles.section} aria-labelledby="batch-editor-steps">
          <div className={styles.sectionHead}>
            <h3 id="batch-editor-steps" className={styles.heading}>
              {m.batch_steps_heading()}
            </h3>
          </div>
          {steps.length === 0 ? <p className={styles.muted}>{m.batch_steps_empty()}</p> : null}
          <ol className={styles.steps}>
            {steps.map((item, index) => {
              const expanded = open === item.key;
              const stepSummary = summary?.steps[index];
              const label = stepKindLabel(item.step.kind);
              const detail = stepSummary ? stepDetail(stepSummary) : '';
              return (
                <li key={item.key} className={styles.step} data-testid="batch-editor-step">
                  <span className={styles.stepNumber}>{index + 1}</span>
                  <button
                    type="button"
                    className={styles.row}
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : item.key)}
                  >
                    <span className={styles.stepTitle}>
                      {expanded ? (
                        <ChevronDown aria-hidden="true" size={12} />
                      ) : (
                        <ChevronRight aria-hidden="true" size={12} />
                      )}{' '}
                      {label}
                    </span>
                    {detail === '' ? null : <span className={styles.stepDetail}>{detail}</span>}
                    {stepSummary && !stepSummary.availability.available ? (
                      <span className={styles.error}>
                        {waitingForLabel(stepSummary.availability.waitingFor)}
                      </span>
                    ) : null}
                  </button>
                  <span className={styles.stepTools}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      disabled={index === 0}
                      aria-label={m.batch_step_move_up({ step: label })}
                      title={m.batch_step_move_up({ step: label })}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      disabled={index === steps.length - 1}
                      aria-label={m.batch_step_move_down({ step: label })}
                      title={m.batch_step_move_down({ step: label })}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={m.batch_step_remove({ step: label })}
                      title={m.batch_step_remove({ step: label })}
                      onClick={() => {
                        setSteps(steps.filter((s) => s.key !== item.key));
                        setError(null);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </span>
                  {expanded ? (
                    <div className={styles.stepForm}>
                      <StepForm
                        step={item.step}
                        onChange={(step) => {
                          setSteps(steps.map((s) => (s.key === item.key ? { ...s, step } : s)));
                          setError(null);
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className={tool.row}>
            <label className={tool.field}>
              <span className={tool.label}>{m.batch_add_step_kind()}</span>
              <select
                className={tool.select}
                value={addKind}
                onChange={(event) => setAddKind(event.target.value as RecipeStepKind)}
              >
                {ADDABLE_STEP_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {stepKindLabel(kind)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`${tool.secondary} ${styles.alignEnd}`}
              disabled={steps.length >= MAX_RECIPE_STEPS}
              onClick={add}
            >
              {m.batch_add_step()}
            </button>
          </div>
        </section>
        {error === null ? null : (
          <p className={styles.error} role="alert" data-testid="batch-editor-error">
            {recipeErrorText(error)}
            <span className={styles.code}>{error.message}</span>
          </p>
        )}
      </div>
      <div className={styles.footer}>
        <span className={styles.footerNote}>{m.batch_editor_note()}</span>
        <button type="button" className={tool.secondary} onClick={onCancel}>
          {m.common_cancel()}
        </button>
        <button
          type="button"
          className={tool.primary}
          disabled={saving}
          onClick={() => void save()}
        >
          {m.batch_save_recipe()}
        </button>
      </div>
    </>
  );
}
