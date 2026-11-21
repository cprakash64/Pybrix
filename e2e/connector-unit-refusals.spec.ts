import { expect, test, type Page } from '@playwright/test';
import { revealControl } from './progressive-disclosure';
import { modelXml, threeMf } from './format-fixtures';

/**
 * RELEASE 2, STAGE C03-C2 — WHAT A PERSON SEES WHEN A CONNECTOR CANNOT BE SIZED, THROUGH THE SHIPPED APPLICATION.
 *
 * A refusal about what the connector was asked to BE (its placement, its unit) is shown as its own sentence, with what is still
 * true, and without advice about the cut: the cut was never examined, so "move the cut" would be wrong. Real files through the real
 * file picker, the real worker and the real engine.
 */
const CUBE: readonly (readonly [number, number, number])[] = [
  [-15, -15, -15],
  [15, -15, -15],
  [-15, 15, -15],
  [15, 15, -15],
  [-15, -15, 15],
  [15, -15, 15],
  [-15, 15, 15],
  [15, 15, 15],
];
const FACES: readonly (readonly [number, number, number])[] = [
  [0, 2, 3],
  [0, 3, 1],
  [4, 5, 7],
  [4, 7, 6],
  [0, 1, 5],
  [0, 5, 4],
  [2, 6, 7],
  [2, 7, 3],
  [0, 4, 6],
  [0, 6, 2],
  [1, 3, 7],
  [1, 7, 5],
];
function threeMfCube(transform: string): Buffer {
  const mesh =
    `<mesh><vertices>${CUBE.map(
      ([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`,
    ).join('')}</vertices>` +
    `<triangles>${FACES.map(
      ([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`,
    ).join('')}</triangles></mesh>`;
  return threeMf(
    modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model" name="Cube">${mesh}</object>`,
      build: `<item objectid="1" transform="${transform}"/>`,
    }),
  );
}
const objCube = (): Buffer =>
  Buffer.from(
    [
      '# a cube: OBJ states no unit',
      ...CUBE.map(([x, y, z]) => `v ${String(x)} ${String(y)} ${String(z)}`),
      ...FACES.map(([a, b, c]) => `f ${String(a + 1)} ${String(b + 1)} ${String(c + 1)}`),
    ].join('\n') + '\n',
  );

async function open(page: Page, name: string, mime: string, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: mime, buffer });
  await expect(page.getByTestId('fact-triangles')).toHaveText('12', { timeout: 60_000 });
}

test.describe('a placement a round pin cannot be sized for', () => {
  for (const [name, transform, sentence] of [
    ['non-uniform scale', '2 0 0 0 1 0 0 0 1 0 0 0', 'Connectors require uniform model scale.'],
    [
      'shear',
      '1 0 0 0.5 0.8660254 0 0 0 1 0 0 0',
      "Connectors aren't supported on sheared model placements.",
    ],
  ] as const)
    test(`${name}: the sentence is shown as itself, and the model is unchanged`, async ({
      page,
    }) => {
      await page.goto('/');
      await open(page, 'placed.3mf', 'model/3mf', threeMfCube(transform));
      await page.getByTestId('workflow-split').click();
      await revealControl(page, page.getByTestId('split-connector-pin'));
      await page.getByTestId('split-connector-pin').check();
      await page.getByTestId('split-preview').click();
      const shown = page.getByTestId('split-connector-input');
      await expect(shown).toBeVisible({ timeout: 60_000 });
      await expect(shown).toContainText(sentence);
      await expect(shown).toContainText('Your model is unchanged.');
      await expect(shown).not.toContainText(/cut|safely|move/i);
      await expect(page.getByTestId('split-error')).toHaveCount(0);
      await expect(page.getByTestId('fact-triangles')).toHaveText('12');
      // a plain cut of the very same model is still available: only a connector depends on the placement
      await revealControl(page, page.getByTestId('split-connector-none'));
      await page.getByTestId('split-connector-none').check();
      await page.getByTestId('split-preview').click();
      await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
    });
});

test('an OBJ states no unit, so a connector waits for the user to say how to read it', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'cube.obj', 'text/plain', objCube());
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-unit-interpretation')).toHaveCount(0);
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await expect(page.getByTestId('split-preview')).toBeDisabled();
  await expect(page.getByTestId('split-connectors-unit')).toContainText('Choose its units');
  // nothing is preselected and nothing is guessed from the size of the model
  await expect(page.getByTestId('split-unit-interpretation').locator('input:checked')).toHaveCount(
    0,
  );
  // once the user says how to read it, the same file takes the connector
  await page.getByTestId('split-unit-interpretation-millimeter').check();
  await expect(page.getByTestId('split-preview')).toBeEnabled();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-preview-label')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('split-result-connector')).toHaveText('Round pins and sockets');
});
