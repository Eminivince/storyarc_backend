declare module "sanitize-html" {
  interface Attributes {
    [attr: string]: string;
  }

  interface IOptions {
    allowedAttributes?: Record<string, string[] | { name: string; values?: string[] }[]> | false;
    allowedSchemes?: string[] | boolean;
    allowedTags?: string[] | false;
    transformTags?: Record<
      string,
      string | ((tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes; text?: string })
    >;
    [key: string]: unknown;
  }

  type Transformer = (tagName: string, attribs: Attributes) => {
    tagName: string;
    attribs: Attributes;
    text?: string;
  };

  function sanitizeHtml(dirty: string, options?: IOptions): string;

  namespace sanitizeHtml {
    export { IOptions };
    export function simpleTransform(
      tagName: string,
      attribs: Attributes,
      merge?: boolean
    ): Transformer;
  }

  export = sanitizeHtml;
}
