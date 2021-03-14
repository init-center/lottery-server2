import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { RecordEntity } from "src/entities/record.entity";
import { encrypt } from "src/utils/encrypt";
import { Connection, Repository } from "typeorm";
import {
  AddDrawCountDto,
  AddPrizeDto,
  DeletePrizeDto,
  GetDrawCountDto,
  GetWinRecordDto,
  UpdatePrizeDto,
} from "../../dto/lotteries/lotteryDto";
import { PrizeEntity } from "../../entities/prize.entity";
import { UserEntity } from "../../entities/user.entity";

@Injectable()
export class LotteriesService {
  constructor(
    @InjectRepository(PrizeEntity)
    private readonly prizesRepository: Repository<PrizeEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    @InjectRepository(RecordEntity)
    private readonly recordRepository: Repository<RecordEntity>,
    private readonly connection: Connection,
  ) {}

  async addPrize(body: AddPrizeDto) {
    const { name, count } = body;

    const newPrize = {
      name,
      count,
    };
    try {
      return await this.prizesRepository.save(newPrize);
    } catch (e) {
      throw new BadRequestException({
        message: "增加奖品失败！",
      });
    }
  }

  async updatePrize(body: UpdatePrizeDto) {
    const { id } = body;

    const existPrize = await this.prizesRepository.findOne({ id });
    if (!existPrize) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message: "奖品不存在！",
      });
    }
    return await this.prizesRepository.update(
      {
        id,
      },
      body,
    );
  }

  async deletePrize(body: DeletePrizeDto) {
    const { id } = body;

    const existPrize = await this.prizesRepository.findOne({ id });
    if (!existPrize) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message: "奖品不存在！",
      });
    }
    try {
      return await this.prizesRepository.delete({ id });
    } catch (e) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: "删除奖品失败！",
      });
    }
  }

  async addDrawCount(body: AddDrawCountDto) {
    const { name, phone, count } = body;

    const hasUser = await this.usersRepository.findOne({
      phone,
    });

    if (!hasUser) {
      const user = {
        name,
        phone,
        password: encrypt(phone),
        count,
      };
      return await this.usersRepository.save(user);
    }

    return await this.usersRepository.update(
      {
        phone,
      },
      {
        count: Number(hasUser.count) + Number(count),
      },
    );
  }

  async getDrawCount(query: GetDrawCountDto) {
    const { phone } = query;

    const hasUser = await this.usersRepository.findOne({
      select: ["uid", "name", "phone", "count"],
      where: {
        phone,
      },
    });

    if (!hasUser) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        message: "用户不存在",
      });
    }

    return hasUser;
  }

  async findAllPrizes() {
    try {
      return await this.prizesRepository.find();
    } catch (e) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: "获取奖品列表失败！",
      });
    }
  }

  async findWinRecordByPhone(query: GetWinRecordDto) {
    try {
      return await this.recordRepository.find({
        where: { user_phone: query.phone },
        order: {
          created_at: "DESC",
        },
      });
    } catch (error) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: "查询中奖记录失败！",
      });
    }
  }

  async randomPrize(user: UserEntity) {
    const allPrizes = await this.findAllPrizes();
    const flatPrizes: PrizeEntity[] = [];
    for (let i = 0; i < allPrizes.length; i++) {
      const prize = allPrizes[i];
      for (let j = 0; j < prize.count; j++) {
        flatPrizes.push(prize);
      }
    }

    if (flatPrizes.length < 1) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        message: "奖池为空，请联系管理员添加！",
      });
    }
    const random = Math.floor(Math.random() * flatPrizes.length);
    const selectedPrize = flatPrizes[random];

    const queryRunner = this.connection.createQueryRunner();
    // 开始事务
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.manager.update(
        UserEntity,
        { id: user.id },
        { count: user.count - 1 },
      );

      const reducePrizeResult = await queryRunner.manager.update(
        PrizeEntity,
        { id: selectedPrize.id },
        { count: selectedPrize.count - 1 },
      );

      const newRecord = new RecordEntity();
      newRecord.prize_id = selectedPrize.id;
      newRecord.prize_name = selectedPrize.name;
      newRecord.user_id = user.id;
      newRecord.user_name = user.name;
      newRecord.user_phone = user.phone;

      const saveRecordResult = await queryRunner.manager.save(newRecord);
      // 提交事务
      await queryRunner.commitTransaction();

      if (result.affected && saveRecordResult && reducePrizeResult.affected) {
        return {
          prize: { id: selectedPrize.id, name: selectedPrize.name },
          count: user.count - 1,
        };
      }
    } catch (e) {
      // 回滚
      await queryRunner.rollbackTransaction();
      throw new InternalServerErrorException({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "服务器错误！",
      });
    } finally {
      // 释放queryRunner
      await queryRunner.release();
    }
  }
}
