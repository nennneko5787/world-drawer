# AGENTS.md

## Specification Management

The `spec/` directory is the source of truth for project specifications, requirements, design decisions, and technical documentation.

### Rules

* Before implementing, modifying, or debugging any feature, **read the relevant Markdown files in `spec/`** to understand the existing requirements and design.
* When you need information about the project's behavior, architecture, APIs, data structures, conventions, or design decisions, check `spec/` first.
* Do not assume that missing information can be safely inferred. If the required specification is unclear or missing, determine what needs to be documented.
* **Any new or clarified requirements, design decisions, constraints, or technical knowledge that may be useful in future work must be documented in a Markdown file under `spec/`.**
* When a specification is missing, incomplete, or outdated, update or create the appropriate Markdown file in `spec/` before proceeding with implementation whenever practical.
* Keep specifications accurate, concise, and consistent with the actual implementation.
* If an implementation changes behavior described in `spec/`, update the relevant specification in the same change.
* Prefer updating an existing specification over creating duplicate documentation.
* Organize specifications into appropriate Markdown files and use clear, descriptive filenames.
* When making changes based on a specification, ensure the implementation conforms to it. If the specification conflicts with the user's explicit request, follow the user's request and update the specification accordingly.

### Workflow

1. Inspect the relevant files under `spec/`.
2. Identify the applicable requirements, constraints, and design decisions.
3. If necessary information is missing, document it in `spec/` using Markdown.
4. Implement or modify the code according to the specifications.
5. Update the relevant specifications if the implementation changes the documented behavior.
6. Review the changes to ensure the code and specifications remain consistent.

### Documentation Requirements

All project-specific knowledge that is important for future development should be recorded in `spec/` as Markdown, including but not limited to:

* Functional requirements and expected behavior
* Architecture and system design
* API contracts and data formats
* Data models and database schemas
* Error handling and edge cases
* Security and performance requirements
* Technical constraints and limitations
* Important implementation decisions and their rationale

Do not leave important project knowledge only in chat messages, temporary notes, or undocumented code.
