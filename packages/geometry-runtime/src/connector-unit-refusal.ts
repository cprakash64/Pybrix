/**
 * WHAT A PERSON IS TOLD WHEN A CONNECTOR CANNOT BE SIZED BECAUSE THE MODEL HAS NO UNIT.
 *
 * A connector is asked for in millimetres, so without a unit there is no physical length to place (Stage C03-C2, Phase 0 policy
 * U1 + U2): the engine refuses, never assuming millimetres and never reading a number as the model's own units, and the page's
 * existing prompt is where a unit is chosen. The sentence says what is missing and what to do about it, and it does not call the
 * model invalid: a file that states no unit is an ordinary file (STL and OBJ never do).
 *
 * One sentence for every way it can happen — a physical manual pin and an automatic connector alike — because the cause and the
 * remedy are the same. Like the other refusal mappers (`connector-transform-refusal`, `connector-dimension-refusal`) this is the
 * only place the words live.
 */
export function describeUnknownUnitRefusal(): string {
  return 'This model has no physical units. Set the model units before adding a physical connector.';
}
