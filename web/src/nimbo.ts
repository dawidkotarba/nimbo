import { exportDB, peakImportFile} from "dexie-export-import";
import { nimboDB } from './datastore/db';
import Board from './datastore/models/Board';
import List from './datastore/models/List';
import Card from './datastore/models/Card';
import { BoardLabel, CardDetails, RESULT_TYPE, SearchObject, SortObject, SwapObject } from './types';

export default class nimbo {
  db: nimboDB;
  boards: Board[];
  selectedCardId: string;
  showCommandPalette: boolean;

  constructor() {
    this.db = new nimboDB();
    this.boards = new Array<Board>();
    this.selectedCardId = null;
    this.showCommandPalette = false;
  }

  public async init(): Promise<boolean> {
    this.boards = await this.db.boards.toArray();
    
    let lists: List[][] = await Promise.all(this.boards.map(b => this.db.lists.where({ boardId: b.id }).toArray()));

    for (let i: number = 0; i < lists.length; i++) {
      this.boards[i].lists = lists[i].sort((a: List, b: List): number => {
        return a.index - b.index
      });

      let cards: Card[][] = await Promise.all(this.boards[i].lists.map(l => this.db.cards.where({ listId: l.id }).toArray()));
      
      for (let j: number = 0; j < this.boards[i].lists.length; j++) {
        this.boards[i].lists[j].cards = cards[j].sort((a: Card, b: Card): number => {
          return a.index - b.index
        });
      }
    }

    return true;
  }
  
  public openPalette() {
    this.showCommandPalette = true;
  }

  public closePalette() {
    this.showCommandPalette = false;
  }

  public async addNewCard(list: List, title: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === list.boardId);
    
    if (boardIndex > -1) {
      let listIndex: number = this.boards[boardIndex].lists.findIndex(l => l.id === list.id); 

      if (listIndex > -1) {
        let c: Card = new Card(list, title);

        this.boards[boardIndex].lists[listIndex].cards = [...this.boards[boardIndex].lists[listIndex].cards, c];

        await this.db.cards.add(c);
      }
    }
  }

  public async addNewList(boardId: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);
    
    if (boardIndex > -1) {
      let l: List = new List(boardId, this.boards[boardIndex].lists.length); 
      this.boards[boardIndex].lists = [...this.boards[boardIndex].lists, l];

      await this.db.lists.add(l);
    }
  }

  public async createBoard(title: string): Promise<string> {
    let b: Board = new Board(title);
    this.boards = [...this.boards, b];

    await this.db.boards.add(b);

    return b.id;
  }

  public async deleteBoard(id: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === id);

    if (boardIndex > -1) {
      this.boards.splice(boardIndex, 1);
    }

    await this.db.boards.delete(id);
  }

  public async deleteCard(list: List, cardId: string): Promise<void> {
    for (let i: number = 0; i < this.boards.length; i++) {
      for (let j: number = 0; j < this.boards[i].lists.length; j++) {
        if (this.boards[i].lists[j].id === list.id) {
          list.deleteCard(cardId);

          this.boards[i].lists[j] = list;
        }
      }
    }

    await this.db.cards.delete(cardId);
  }

  public async deleteList(boardId: string, listId: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);
    
    if (boardIndex > -1) {
      let listIndex: number = this.boards[boardIndex].lists.findIndex(l => l.id === listId); 

      if (listIndex > -1) {
        let listIndexes: object = {};
        
        this.boards[boardIndex].lists.splice(listIndex, 1);
        
        for (let i: number = 0; i < this.boards[boardIndex].lists.length; i++) {
          this.boards[boardIndex].lists[i].index = i;

          listIndexes[this.boards[boardIndex].lists[i].id] = i;
        };

        await this.db.transaction('rw', this.db.lists, this.db.cards, async (): Promise<void> =>{
          await Promise.all([
            this.db.lists.delete(listId),
            this.db.cards.where({ listId }).delete()
          ]);
        });

        await this.updateListIndexes(listIndexes);
      }
    }
  }

  public async export(): Promise<Blob> {
    return await exportDB(this.db);
  }

  public everything(): SearchObject[] {
    return (this.boards.map((b) => {
      if (b.isArchived) return [];

      return [{
        type: RESULT_TYPE.BOARD,
        text: b.title,
        path: `/b/${b.id}`
      }, b.lists.map(l => {
          return l.cards.map(c => {
            return {
              type: RESULT_TYPE.CARD,
              text: c.title,
              path: `/c/${c.id}`
            };
          });
        })
      ];
    }) as any).flat(4);
  }

  public getBoard(boardId: string): Board | null {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      return this.boards[boardIndex];
    }

    return null;
  }

  public getCardDetails(cardId: string): CardDetails | null {
    for (let i: number = 0; i < this.boards.length; i++) {
      for (let j: number = 0; j < this.boards[i].lists.length; j++) {
        for (let k: number = 0; k < this.boards[i].lists[j].cards.length; k++) {
          if (this.boards[i].lists[j].cards[k].id === cardId) {
            return {
              board: this.boards[i],
              list: this.boards[i].lists[j],
              card: this.boards[i].lists[j].cards[k]
            }
          }
        }
      }
    }

    return null;
  }

  public async import(db: File): Promise<boolean> {
    try {
      let e = await peakImportFile(db);

      if (e.formatName == "dexie" && e.formatVersion == 1)  {
         await this.db.import(db);
         return true;
      }
    } catch (err) {};

    return;
  }

  public async importTrelloBoard(b: any): Promise<string> {
    let board: Board = new Board(b.name);

    board.lastViewTime = new Date(b.dateLastView).getTime();
    board.isStarred = b.starred;
    board.isArchived = b.closed;

    let cards: Card[] = [];
    let lists: List[] = [];

    for (let i: number = 0; i < b.lists.length; i++) {
      let l: List = new List(board.id, i);
      l.setTitle(b.lists[i].name);

      for (let j: number = 0; j < b.cards.length; j++) {
        if (b.lists[i].id === b.cards[j].idList) {
          let c: Card = new Card(l, b.cards[j].name);

          c.description = b.cards[j].desc; 
          c.due = b.cards[j].due ? new Date(b.cards[j].due).getTime() : null;
          c.isComplete = b.cards[j].dueComplete;
          
          l.cards.push(c);
        }
      }

      lists.push(l);
    }

    for (let i: number = 0; i < lists.length; i++) {
      cards = cards.concat(lists[i].cards);
    }

    await this.db.transaction('rw', this.db.boards, this.db.lists, this.db.cards, async (): Promise<void> =>{
      await Promise.all([
        this.db.boards.add(board),
        this.db.lists.bulkAdd(lists),
        this.db.cards.bulkAdd(cards)
      ]);
    });

    return board.id;
  }

  public async moveCard(c: SortObject): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === c.boardId);

    if (boardIndex > -1) {
      let listFromIndex: number = this.boards[boardIndex].lists.findIndex(l => l.id === c.from.list); 
      let listToIndex: number = this.boards[boardIndex].lists.findIndex(l => l.id === c.to.list); 

      if (listFromIndex > -1 && listToIndex > -1) {
        let cardIndexes: object = {};
        let tmp: Card;

        if (c.from.list != c.to.list) {
          let fromListId: string;

          tmp = this.boards[boardIndex].lists[listFromIndex].cards.splice(c.from.index, 1)[0]; 
          fromListId = tmp.listId;

          tmp.listId = this.boards[boardIndex].lists[listToIndex].id;
          tmp.index = c.to.index;

          for (let i: number = 0; i < this.boards[boardIndex].lists[listFromIndex].cards.length; i++) {
            this.boards[boardIndex].lists[listFromIndex].cards[i].index = i;

            cardIndexes[this.boards[boardIndex].lists[listFromIndex].cards[i].id] = i;
          }
          
          this.boards[boardIndex].lists[listToIndex].cards.splice(c.to.index, 0, tmp);

          for (let i: number = 0; i < this.boards[boardIndex].lists[listToIndex].cards.length; i++) {
            this.boards[boardIndex].lists[listToIndex].cards[i].index = i;

            cardIndexes[this.boards[boardIndex].lists[listToIndex].cards[i].id] = i;
          }
        } else {
          if (c.from.index != c.to.index) {
            tmp = this.boards[boardIndex].lists[listFromIndex].cards.splice(c.from.index, 1)[0];
            tmp.index = c.to.index;

            this.boards[boardIndex].lists[listFromIndex].cards.splice(c.to.index, 0, tmp);

            for (let i: number = 0; i < this.boards[boardIndex].lists[listFromIndex].cards.length; i++) {
              this.boards[boardIndex].lists[listFromIndex].cards[i].index = i;

              cardIndexes[this.boards[boardIndex].lists[listFromIndex].cards[i].id] = i;
            }
          }
        }

        await this.updateCardIndexes(tmp, cardIndexes);
      }
    }
  }

  public setSelectedCard(cardId: string | null): void {
    this.selectedCardId = cardId;
  }

  public async swapLists(boardId: string, l: SwapObject): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      this.boards[boardIndex].swapLists(l);

      await this.db.transaction('rw', this.db.lists, async (): Promise<void> =>{
        let [from, to]: List[] = await Promise.all([
          this.db.lists.get({ boardId, index: l.from }),
          this.db.lists.get({ boardId, index: l.to })
        ]);
        
        from.index = l.to;
        to.index = l.from;

        await this.db.lists.bulkPut([from, to]);
      });
    }
  }

  public async toggleBoardArchive(boardId: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      this.boards[boardIndex].toggleBoardArchive();

      await this.db.boards.update(boardId, {
        isArchived: this.boards[boardIndex].isArchived
      });
    }
  }

  public async toggleBoardStar(boardId: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      this.boards[boardIndex].toggleBoardStar();

      await this.db.boards.update(boardId, {
        isStarred: this.boards[boardIndex].isStarred
      });
    }
  }

  public async updateBoardTitle(boardId: string, title: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      this.boards[boardIndex].setTitle(title);

      await this.db.boards.update(boardId, {
        title
      });
    }
  }

  public async updateCard(c: Card, property: string): Promise<void> {
    for (let i: number = 0; i < this.boards.length; i++) {
      for (let j: number = 0; j < this.boards[i].lists.length; j++) {
        for (let k: number = 0; k < this.boards[i].lists[j].cards.length; k++) {
          if (this.boards[i].lists[j].cards[k].id === c.id) {            
            this.boards[i].lists[j].cards[k] = c;
          }
        }
      }
    }
    
    await this.db.cards.update(c.id, {
      [property]: c[property]
    });
  }

  private async updateCardIndexes(c: Card, cardIndexes: object): Promise<void> {
    await this.db.transaction('rw', this.db.cards, async (): Promise<void> =>{
      await this.db.cards.update(c.id, {
        listId: c.listId
      });

      await this.db.cards.where("id").anyOf(Object.keys(cardIndexes)).modify(c => {
        c.index = cardIndexes[c.id];
      })
    });
  }

  public async updateLabels(boardId: string, labels: BoardLabel[]): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);

    if (boardIndex > -1) {
      this.boards[boardIndex].setLabels(labels);

      await this.db.boards.update(boardId, {
        labels
      });
    }
  }

  private async updateListIndexes(listIndexes: object): Promise<void> {
    await this.db.lists.where("id").anyOf(Object.keys(listIndexes)).modify(l => {
      l.index = listIndexes[l.id];
    });
  }

  public async updateListTitle(boardId: string, listId: string, title: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);
    
    if (boardIndex > -1) {
      let listIndex: number = this.boards[boardIndex].lists.findIndex(l => l.id === listId); 

      if (listIndex > -1) {
        this.boards[boardIndex].lists[listIndex].setTitle(title);

        await this.db.lists.update(listId, {
          title
        });
      }
    }
  }

  public async updateViewTime(boardId: string): Promise<void> {
    let boardIndex: number = this.boards.findIndex(b => b.id === boardId);
    
    if (boardIndex > -1) {
      let lastViewTime: number = new Date().getTime();
      this.boards[boardIndex].setLastViewTime(lastViewTime);

      await this.db.boards.update(boardId, {
        lastViewTime
      });
    }
  }
}