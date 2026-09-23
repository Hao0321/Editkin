export class EditGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditGraphError";
  }
}
