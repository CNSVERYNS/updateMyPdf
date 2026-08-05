// Central capability catalog. `implemented` means the local PDF executor is wired;
// `planned` means the contract is defined but its executor still needs implementation;
// `external` means it needs a service, storage, signing provider, or OS-level worker.
export const CAPABILITIES = [
  // Edit PDF
  { id: 'set_title', category: 'edit', label: 'Change document title', status: 'implemented' },
  { id: 'replace_text', category: 'edit', label: 'Replace visible text', status: 'implemented' },
  { id: 'style_text', category: 'edit', label: 'Change text color and style', status: 'implemented' },
  { id: 'add_text', category: 'edit', label: 'Add text', status: 'implemented' },
  { id: 'delete_text', category: 'edit', label: 'Remove visible text', status: 'implemented' },
  { id: 'add_image', category: 'edit', label: 'Add image', status: 'implemented' },
  { id: 'replace_image', category: 'edit', label: 'Replace embedded image', status: 'implemented' },
  { id: 'resize_image', category: 'edit', label: 'Place uploaded image at size and position', status: 'implemented' },
  { id: 'edit_metadata', category: 'edit', label: 'Edit PDF metadata', status: 'implemented' },
  { id: 'add_link', category: 'edit', label: 'Add or edit link', status: 'implemented' },
  { id: 'header_footer', category: 'edit', label: 'Add header or footer', status: 'implemented' },
  { id: 'watermark', category: 'edit', label: 'Add watermark', status: 'implemented' },
  { id: 'bates_numbering', category: 'edit', label: 'Add Bates numbering', status: 'implemented' },

  // Organize pages
  { id: 'delete_page', category: 'organize', label: 'Delete page', status: 'implemented' },
  { id: 'rotate_page', category: 'organize', label: 'Rotate page', status: 'implemented' },
  { id: 'reorder_pages', category: 'organize', label: 'Reorder pages', status: 'implemented' },
  { id: 'insert_page', category: 'organize', label: 'Insert page', status: 'implemented' },
  { id: 'duplicate_page', category: 'organize', label: 'Duplicate page', status: 'implemented' },
  { id: 'extract_pages', category: 'organize', label: 'Extract pages', status: 'implemented' },
  { id: 'split_pdf', category: 'organize', label: 'Split PDF', status: 'implemented' },
  { id: 'merge_pdf', category: 'organize', label: 'Merge PDFs', status: 'implemented' },
  { id: 'crop_page', category: 'organize', label: 'Crop page', status: 'implemented' },
  { id: 'resize_page', category: 'organize', label: 'Resize page', status: 'implemented' },
  { id: 'flatten_pdf', category: 'organize', label: 'Flatten PDF', status: 'implemented' },

  // Comment and markup
  { id: 'highlight', category: 'markup', label: 'Highlight text', status: 'implemented' },
  { id: 'underline', category: 'markup', label: 'Underline text', status: 'implemented' },
  { id: 'strikethrough', category: 'markup', label: 'Strikethrough text', status: 'implemented' },
  { id: 'squiggly', category: 'markup', label: 'Squiggly underline', status: 'implemented' },
  { id: 'sticky_note', category: 'markup', label: 'Add sticky note', status: 'implemented' },
  { id: 'comment', category: 'markup', label: 'Add comment', status: 'implemented' },
  { id: 'freehand', category: 'markup', label: 'Draw freehand', status: 'implemented' },
  { id: 'shape', category: 'markup', label: 'Add shape', status: 'implemented' },
  { id: 'stamp', category: 'markup', label: 'Add stamp', status: 'implemented' },
  { id: 'measure', category: 'markup', label: 'Measure document', status: 'implemented' },

  // Forms
  { id: 'detect_form_fields', category: 'forms', label: 'Detect form fields', status: 'implemented' },
  { id: 'add_text_field', category: 'forms', label: 'Add text field', status: 'implemented' },
  { id: 'add_checkbox', category: 'forms', label: 'Add checkbox', status: 'implemented' },
  { id: 'add_radio', category: 'forms', label: 'Add radio button', status: 'implemented' },
  { id: 'add_dropdown', category: 'forms', label: 'Add dropdown', status: 'implemented' },
  { id: 'add_signature_field', category: 'forms', label: 'Add interactive signature field', status: 'implemented' },
  { id: 'fill_form', category: 'forms', label: 'Fill form', status: 'implemented' },
  { id: 'flatten_form', category: 'forms', label: 'Flatten form fields', status: 'implemented' },
  { id: 'export_form_data', category: 'forms', label: 'Export form data', status: 'implemented' },

  // Convert and create
  { id: 'create_pdf', category: 'convert', label: 'Create PDF', status: 'implemented' },
  { id: 'export_word', category: 'convert', label: 'Export text to Word', status: 'implemented' },
  { id: 'export_excel', category: 'convert', label: 'Export text to Excel', status: 'implemented' },
  { id: 'export_powerpoint', category: 'convert', label: 'Export text to PowerPoint', status: 'implemented' },
  { id: 'export_image', category: 'convert', label: 'Export pages as images', status: 'implemented' },
  { id: 'export_html', category: 'convert', label: 'Convert to HTML', status: 'implemented' },
  { id: 'compress_pdf', category: 'convert', label: 'Compress PDF', status: 'implemented' },
  { id: 'optimize_pdf', category: 'convert', label: 'Optimize PDF (lossless rewrite)', status: 'implemented' },
  { id: 'ocr_scan', category: 'convert', label: 'OCR scanned PDF', status: 'implemented' },

  // AI productivity and analysis
  { id: 'summarize', category: 'ai', label: 'Summarize document', status: 'implemented' },
  { id: 'answer_question', category: 'ai', label: 'Answer questions about document', status: 'implemented' },
  { id: 'translate', category: 'ai', label: 'Translate selected text', status: 'implemented' },
  { id: 'rewrite_text', category: 'ai', label: 'Rewrite selected text', status: 'implemented' },
  { id: 'extract_data', category: 'ai', label: 'Extract structured data', status: 'implemented' },
  { id: 'extract_table', category: 'ai', label: 'Extract tables', status: 'implemented' },
  { id: 'extract_text', category: 'ai', label: 'Extract PDF text', status: 'implemented' },
  { id: 'compare_pdfs', category: 'ai', label: 'Compare two PDFs', status: 'implemented' },
  { id: 'document_citations', category: 'ai', label: 'Answer with page citations', status: 'implemented' },
  { id: 'audio_overview', category: 'ai', label: 'Create audio overview', status: 'implemented' },

  // Sign and e-signature
  { id: 'add_signature', category: 'esign', label: 'Add signature', status: 'implemented' },
  { id: 'fill_and_sign', category: 'esign', label: 'Fill and sign', status: 'implemented' },
  { id: 'request_signature', category: 'esign', label: 'Request signatures', status: 'external' },
  { id: 'track_signature', category: 'esign', label: 'Track signature status', status: 'external' },
  { id: 'validate_signature', category: 'esign', label: 'Validate digital signature', status: 'planned' },
  { id: 'certificate_sign', category: 'esign', label: 'Certificate-based signing', status: 'planned' },

  // Protect and share
  { id: 'password_protect', category: 'security', label: 'Password protect PDF', status: 'implemented' },
  { id: 'remove_password', category: 'security', label: 'Remove password protection', status: 'implemented' },
  { id: 'set_permissions', category: 'security', label: 'Restrict edit, print, or copy', status: 'implemented' },
  { id: 'redact', category: 'security', label: 'Permanently redact content', status: 'implemented' },
  { id: 'remove_hidden_data', category: 'security', label: 'Remove hidden information', status: 'implemented' },
  { id: 'certify_pdf', category: 'security', label: 'Certify PDF', status: 'planned' },
  { id: 'share_link', category: 'collaboration', label: 'Create expiring secure share link', status: 'implemented' },
  { id: 'review_access', category: 'collaboration', label: 'Manage reviewer access', status: 'external' },
  { id: 'audit_trail', category: 'collaboration', label: 'Create audit trail', status: 'external' },

  // Advanced production and accessibility
  { id: 'accessibility_check', category: 'accessibility', label: 'Check accessibility', status: 'implemented' },
  { id: 'tag_pdf', category: 'accessibility', label: 'Mark PDF and set language', status: 'implemented' },
  { id: 'set_alt_text', category: 'accessibility', label: 'Set image alt text', status: 'implemented' },
  { id: 'reading_order', category: 'accessibility', label: 'Set basic reading order metadata', status: 'implemented' },
  { id: 'pdfa_convert', category: 'production', label: 'Convert to PDF/A-2b', status: 'implemented' },
  { id: 'pdfx_preflight', category: 'production', label: 'Preflight PDF/X-4', status: 'implemented' },
  { id: 'print_production', category: 'production', label: 'Prepare for print production', status: 'implemented' },
  { id: 'javascript_action', category: 'advanced', label: 'Add PDF JavaScript action', status: 'implemented' },
  { id: 'portfolio', category: 'advanced', label: 'Create PDF portfolio', status: 'implemented' },
]

export const CAPABILITY_CATEGORIES = [
  { id: 'edit', label: 'Edit PDF' },
  { id: 'organize', label: 'Organize pages' },
  { id: 'markup', label: 'Comments and markup' },
  { id: 'forms', label: 'Forms' },
  { id: 'convert', label: 'Create and convert' },
  { id: 'ai', label: 'AI productivity' },
  { id: 'esign', label: 'E-signatures' },
  { id: 'security', label: 'Protect and redact' },
  { id: 'collaboration', label: 'Share and collaborate' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'production', label: 'Print production' },
  { id: 'advanced', label: 'Advanced PDF' },
]

export const getCapabilitySummary = () => ({
  categories: CAPABILITY_CATEGORIES,
  capabilities: CAPABILITIES,
  counts: CAPABILITIES.reduce((counts, capability) => {
    counts[capability.status] = (counts[capability.status] || 0) + 1
    return counts
  }, {}),
})
