/**
 * The DOM event under a React synthetic event, as far as IME handling reads it. InputEvent, KeyboardEvent and
 * CompositionEvent carry `isComposing`, and KeyboardEvent the legacy `keyCode` (229 while an IME owns the key).
 * A change event's plain Event, FocusEvent and PointerEvent carry neither, so both read as undefined there.
 *
 * `object &` is deliberate. With only optional members this would be a TypeScript "weak type", and React's
 * `nativeEvent: Event | FocusEvent | PointerEvent` shares none of those members, so a real handler slot such as
 * `onChange`/`onBlur`/`onPointerDown` would refuse the binding even though the read is safe. The intersection keeps
 * the same members while accepting every DOM event and the plain-object events the pure source tests construct.
 */
export type NativeImeEventV1 = object & { readonly isComposing?: boolean; readonly keyCode?: number };
