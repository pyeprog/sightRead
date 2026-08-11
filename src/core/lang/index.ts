/**
 * Per-language syntax dispatch (design.md §3.4). Each language implements the
 * whole `LanguageSyntax` function group in its own module and is picked here
 * wholesale by VS Code languageId; unknown languages fall back to the generic
 * mixed-keyword module. To support a new language, add a module beside the
 * existing ones and register its ids below.
 */

import { cCppSyntax } from './cCpp';
import { csharpSyntax } from './csharp';
import { genericSyntax } from './generic';
import { goSyntax } from './go';
import { javaSyntax } from './java';
import { kotlinSyntax } from './kotlin';
import { phpSyntax } from './php';
import { pythonSyntax } from './python';
import { rubySyntax } from './ruby';
import { rustSyntax } from './rust';
import { swiftSyntax } from './swift';
import { tsJsSyntax } from './tsJs';
import { LanguageSyntax } from './types';

const BY_LANGUAGE = new Map<string, LanguageSyntax>([
  ['javascript', tsJsSyntax],
  ['javascriptreact', tsJsSyntax],
  ['typescript', tsJsSyntax],
  ['typescriptreact', tsJsSyntax],
  ['python', pythonSyntax],
  ['go', goSyntax],
  ['rust', rustSyntax],
  ['java', javaSyntax],
  ['csharp', csharpSyntax],
  ['c', cCppSyntax],
  ['cpp', cCppSyntax],
  ['ruby', rubySyntax],
  ['php', phpSyntax],
  ['swift', swiftSyntax],
  ['kotlin', kotlinSyntax],
]);

export function syntaxFor(languageId: string): LanguageSyntax {
  return BY_LANGUAGE.get(languageId) ?? genericSyntax;
}
