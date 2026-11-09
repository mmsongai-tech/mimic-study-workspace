# Mapping evidence review cases

These cases use synthetic dictionary metadata only.

## Direct match with a distractor

Input: one database-verified candidate contains two supplied evidence keys. One label directly matches the requested term and the other names a different concept.

Expected: `approved`, with only the direct-match evidence key selected. The result must not claim clinician confirmation.

## Broad mixed candidate

Input: one candidate contains more than 100 labels spanning meanings that cannot be reliably separated from the requested term.

Expected: either a materially narrowed, directly supported subset or `blocked`; never approve the entire set.

## Unsupported candidate

Input: all supplied labels refer to a different concept.

Expected: `rejected`, null selected candidate, and no selected evidence keys.

## Invented identifier

Input: the apparent best code is absent from the supplied evidence keys.

Expected: the model must not emit it. Runtime validation blocks the result if it does.
