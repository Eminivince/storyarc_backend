import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService } from "../admin-audit.service";

@Injectable()
export class AdminHelpCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE") throw new NotFoundException("User not found.");
    if (user.role !== "ADMIN") throw new ForbiddenException("Admin access is required.");
    return user;
  }

  async getAdminHelpCenter(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const categories = await this.prisma.helpCenterCategory.findMany({
      include: { _count: { select: { articles: true } } },
      orderBy: { sortOrder: "asc" },
    });

    const articles = await this.prisma.helpCenterArticle.findMany({
      orderBy: { sortOrder: "asc" },
    });

    return {
      categories: categories.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        icon: c.icon,
        sortOrder: c.sortOrder,
        articleCount: c._count.articles,
      })),
      articles: articles.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        title: a.title,
        excerpt: a.excerpt,
        body: a.body,
        tag: a.tag,
        sortOrder: a.sortOrder,
        published: a.published,
      })),
    };
  }

  async createHelpCenterCategory(
    adminUserId: string,
    input: { title: string; description: string; icon: string; sortOrder?: number | null },
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const category = await this.prisma.helpCenterCategory.create({
      data: {
        title: input.title,
        description: input.description,
        icon: input.icon,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await this.audit.log(admin.id, {
      detail: `Created help center category "${input.title}".`,
      icon: "help",
      summary: `Created help center category "${input.title}"`,
      targetId: category.id,
      targetType: "HELP_CENTER",
    });

    return { category };
  }

  async createHelpCenterArticle(
    adminUserId: string,
    input: {
      categoryId: string;
      title: string;
      excerpt: string;
      body?: string | null;
      published?: boolean | null;
      tag?: string | null;
      sortOrder?: number | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const category = await this.prisma.helpCenterCategory.findUnique({
      where: { id: input.categoryId },
    });

    if (!category) {
      throw new NotFoundException("Help center category not found.");
    }

    const article = await this.prisma.helpCenterArticle.create({
      data: {
        categoryId: input.categoryId,
        title: input.title,
        excerpt: input.excerpt,
        body: input.body ?? null,
        published: input.published ?? true,
        tag: input.tag ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await this.audit.log(admin.id, {
      detail: `Created help center article "${input.title}" in category "${category.title}".`,
      icon: "article",
      summary: `Created help center article "${input.title}"`,
      targetId: article.id,
      targetType: "HELP_CENTER",
    });

    return { article };
  }

  async deleteHelpCenterArticle(adminUserId: string, articleId: string) {
    const admin = await this.requireAdmin(adminUserId);

    const article = await this.prisma.helpCenterArticle.findUnique({
      where: { id: articleId },
      include: { category: true },
    });

    if (!article) {
      throw new NotFoundException("Help center article not found.");
    }

    await this.prisma.helpCenterArticle.delete({ where: { id: articleId } });

    await this.audit.log(admin.id, {
      detail: `Deleted help center article "${article.title}" from category "${article.category.title}".`,
      icon: "delete",
      summary: `Deleted help center article "${article.title}"`,
      targetId: article.id,
      targetType: "HELP_CENTER",
    });

    return {
      deletedArticleId: article.id,
      message: `Deleted "${article.title}" from the help center.`,
    };
  }
}
