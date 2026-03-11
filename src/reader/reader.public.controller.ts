import { Controller, Get } from "@nestjs/common";
import { ReaderService } from "./reader.service";

@Controller("reader")
export class ReaderPublicController {
  constructor(private readonly readerService: ReaderService) {}

  @Get("home")
  async getHomeCatalog() {
    return this.readerService.getHomeCatalog();
  }
}
