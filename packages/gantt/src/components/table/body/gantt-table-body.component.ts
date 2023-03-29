import { debounceTime, filter, startWith, Subject, takeUntil } from 'rxjs';
import {
    Component,
    HostBinding,
    TemplateRef,
    QueryList,
    Input,
    OnInit,
    Inject,
    Output,
    EventEmitter,
    OnDestroy,
    ChangeDetectorRef,
    ViewChildren,
    AfterViewInit
} from '@angular/core';
import {
    GanttItemInternal,
    GanttGroupInternal,
    GanttSelectedEvent,
    GanttTableDropPosition,
    GanttTableDragEnterPredicateContext,
    GanttTableDragDroppedEvent
} from '../../../class';
import { NgxGanttTableColumnComponent } from '../../../table/gantt-column.component';
import { coerceCssPixelValue } from '@angular/cdk/coercion';
import { GanttAbstractComponent, GANTT_ABSTRACT_TOKEN } from '../../../gantt-abstract';
import { defaultColumnWidth } from '../header/gantt-table-header.component';
import { GanttUpper, GANTT_UPPER_TOKEN } from '../../../gantt-upper';
import { CdkDrag, CdkDragDrop, CdkDragEnd, CdkDragMove, CdkDragStart } from '@angular/cdk/drag-drop';
import { DOCUMENT } from '@angular/common';
@Component({
    selector: 'gantt-table-body',
    templateUrl: './gantt-table-body.component.html'
})
export class GanttTableBodyComponent implements OnInit, OnDestroy, AfterViewInit {
    private _renderData: (GanttGroupInternal | GanttItemInternal)[];
    @Input() set renderData(data: (GanttGroupInternal | GanttItemInternal)[]) {
        const firstData = data[0];
        if (firstData && firstData.hasOwnProperty('items')) {
            this.hasGroup = true;
        }
        this.ganttTableEmptyClass = data?.length ? false : true;
        this._renderData = data;
    }

    get renderData() {
        return this._renderData;
    }

    @Input() flatData: (GanttGroupInternal | GanttItemInternal)[];

    @Input() columns: QueryList<NgxGanttTableColumnComponent>;

    @Input() groupTemplate: TemplateRef<any>;

    @Input() emptyTemplate: TemplateRef<any>;

    @Input() rowBeforeTemplate: TemplateRef<any>;

    @Input() rowAfterTemplate: TemplateRef<any>;

    @HostBinding('class.gantt-table-draggable')
    @Input()
    draggable = false;

    @Input() dropEnterPredicate?: (context: GanttTableDragEnterPredicateContext) => boolean;

    @Output() dragDropped = new EventEmitter<GanttTableDragDroppedEvent>();

    @Output() itemClick = new EventEmitter<GanttSelectedEvent>();

    @HostBinding('class.gantt-table-body') ganttTableClass = true;

    @HostBinding('class.gantt-table-empty') ganttTableEmptyClass = false;

    @HostBinding('class.gantt-table-dragging') ganttTableDragging = false;

    @ViewChildren(CdkDrag<string>) cdkDrags: QueryList<CdkDrag<GanttItemInternal>>;

    public hasGroup: boolean;

    public hasExpandIcon = false;

    // 缓存 Element 和 DragRef 的关系，方便在 Item 拖动时查找
    private itemDragRefMap = new Map<HTMLElement, CdkDrag<GanttItemInternal>>();

    private itemDragMoved = new Subject<CdkDragMove>();

    // Item 拖动经过目标时临时记录目标id以及相对应目标的位置
    private itemDropTarget: {
        position?: GanttTableDropPosition;
        id?: string;
    };

    private destroy$ = new Subject<void>();

    constructor(
        @Inject(GANTT_ABSTRACT_TOKEN) public gantt: GanttAbstractComponent,
        @Inject(GANTT_UPPER_TOKEN) public ganttUpper: GanttUpper,
        private cdr: ChangeDetectorRef,
        @Inject(DOCUMENT) private document: Document
    ) {}

    ngOnInit() {
        this.columns.changes.pipe(startWith(this.columns), takeUntil(this.destroy$)).subscribe(() => {
            this.hasExpandIcon = false;
            this.columns.forEach((column) => {
                if (!column.columnWidth) {
                    column.columnWidth = coerceCssPixelValue(defaultColumnWidth);
                }
                if (column.showExpandIcon) {
                    this.hasExpandIcon = true;
                }
            });
            this.cdr.detectChanges();
        });
    }

    ngAfterViewInit(): void {
        this.cdkDrags.changes
            .pipe(startWith(this.cdkDrags), takeUntil(this.destroy$))
            .subscribe((drags: QueryList<CdkDrag<GanttItemInternal>>) => {
                this.itemDragRefMap.clear();
                drags.forEach((drag) => {
                    if (drag.data) {
                        // cdkDrag 变化时，缓存 Element 与 DragRef 的关系，方便 Drag Move 时查找
                        this.itemDragRefMap.set(drag.element.nativeElement, drag);
                    }
                });
            });

        this.itemDragMoved
            .pipe(
                debounceTime(30),
                //  debounce 可能会导致拖动结束后仍然执行 moved ，所以通过判断 dragging 状态来过滤无效 moved
                filter((event: CdkDragMove) => event.source._dragRef.isDragging()),
                takeUntil(this.destroy$)
            )
            .subscribe((event) => {
                this.onItemDragMoved(event);
            });
    }

    expandGroup(group: GanttGroupInternal) {
        this.gantt.expandGroup(group);
    }

    expandChildren(event: MouseEvent, item: GanttItemInternal) {
        event.stopPropagation();
        this.gantt.expandChildren(item);
    }

    onItemDragStarted(event: CdkDragStart<GanttItemInternal>) {
        this.ganttTableDragging = true;
        // 拖动开始时隐藏所有的子项
        const children = this.getChildrenElementsByElement(event.source.element.nativeElement);
        children.forEach((element) => {
            element.classList.add('drag-item-hide');
        });
    }

    emitItemDragMoved(event: CdkDragMove) {
        this.itemDragMoved.next(event);
    }

    onItemDragMoved(event: CdkDragMove<GanttItemInternal>) {
        // 通过鼠标位置查找对应的目标 Item 元素
        let currentPointElement = this.document.elementFromPoint(event.pointerPosition.x, event.pointerPosition.y) as HTMLElement;
        if (!currentPointElement) {
            this.cleanupDragArtifacts();
            return;
        }
        let targetElement = currentPointElement.classList.contains('gantt-table-item')
            ? currentPointElement
            : (currentPointElement.closest('.gantt-table-item') as HTMLElement);
        if (!targetElement) {
            this.cleanupDragArtifacts();
            return;
        }

        // 缓存放置目标Id 并计算鼠标相对应的位置
        this.itemDropTarget = {
            id: this.itemDragRefMap.get(targetElement)?.data.id,
            position: this.getTargetPosition(targetElement, event)
        };

        // 执行外部传入的 dropEnterPredicate 判断是否允许拖入目标项
        if (this.dropEnterPredicate) {
            const targetDragRef = this.itemDragRefMap.get(targetElement);
            if (
                this.dropEnterPredicate({
                    source: event.source.data.origin,
                    target: targetDragRef.data.origin,
                    dropPosition: this.itemDropTarget.position
                })
            ) {
                this.showDropPositionPlaceholder(targetElement);
            } else {
                this.itemDropTarget = null;
            }
        } else {
            this.showDropPositionPlaceholder(targetElement);
        }
    }

    onItemDragEnded(event: CdkDragEnd<GanttItemInternal>) {
        this.ganttTableDragging = false;
    }

    onListDropped(event: CdkDragDrop<GanttItemInternal[], GanttItemInternal[], GanttItemInternal>) {
        if (!this.itemDropTarget) {
            return;
        }
        const targetDragRef = this.cdkDrags.find((item) => item.data?.id === this.itemDropTarget.id);
        const sourceItem = event.item.data;
        const targetItem = targetDragRef?.data;

        this.removeItem(sourceItem);

        switch (this.itemDropTarget.position) {
            case 'before':
            case 'after':
                this.insertItem(targetItem, sourceItem, this.itemDropTarget.position);
                sourceItem.updateLevel(targetItem.level);
                break;
            case 'inside':
                this.insertChildrenItem(targetItem, sourceItem);
                sourceItem.updateLevel(targetItem.level + 1);
                break;
        }

        this.dragDropped.emit({
            source: sourceItem.origin,
            sourceParent: this.getParentByItem(sourceItem)?.origin,
            target: targetItem.origin,
            targetParent: this.getParentByItem(targetItem)?.origin,
            dropPosition: this.itemDropTarget.position
        });

        this.cleanupDragArtifacts(true);
    }

    trackBy(index: number, item: GanttGroupInternal | GanttItemInternal) {
        return item.id || index;
    }

    ngOnDestroy(): void {
        this.destroy$.next();
        this.destroy$.complete();
    }

    private removeItem(item: GanttItemInternal) {
        this.renderData.splice(this.renderData.indexOf(item), 1);
        this.flatData.splice(this.flatData.indexOf(item), 1);
    }

    private insertItem(target: GanttItemInternal, inserted: GanttItemInternal, position: 'before' | 'after') {
        if (position === 'before') {
            this.renderData.splice(this.renderData.indexOf(target), 0, inserted);
            this.flatData.splice(this.flatData.indexOf(target), 0, inserted);
        } else {
            const dragRef = this.cdkDrags.find((drag) => drag.data === target);
            // 如果目标项是展开的，插入的 index 位置需要考虑子项的数量
            let childrenCount = 0;
            if (target.expanded) {
                childrenCount = this.getChildrenElementsByElement(dragRef.element.nativeElement)?.length || 0;
            }
            this.renderData.splice(this.renderData.indexOf(target) + 1 + childrenCount, 0, inserted);
            this.flatData.splice(this.flatData.indexOf(target) + 1 + childrenCount, 0, inserted);
        }
    }

    private insertChildrenItem(target: GanttItemInternal, inserted: GanttItemInternal) {
        if (target.expanded) {
            this.renderData.splice(this.renderData.indexOf(target) + target.children.length + 1, 0, inserted);
            this.flatData.splice(this.flatData.indexOf(target) + target.children.length + 1, 0, inserted);
        }
        target.children.push(inserted);
    }

    private getParentByItem(item: GanttItemInternal) {
        return (this.flatData || []).find((n: GanttItemInternal) => {
            return n.children?.includes(item);
        });
    }

    private getChildrenElementsByElement(dragElement: HTMLElement) {
        // 通过循环持续查找 next element，如果 element 的 level 小于当前 item 的 level，则为它的 children
        const children: HTMLElement[] = [];
        const dragRef = this.itemDragRefMap.get(dragElement);

        // 如果当前的 Drag 正在拖拽，会创建 PlaceholderElement 占位，所以以 PlaceholderElement 向下查找
        let nextElement = (dragRef.getPlaceholderElement() || dragElement).nextElementSibling as HTMLElement;
        let nextDragRef = this.itemDragRefMap.get(nextElement);

        while (nextDragRef && nextDragRef.data.level > dragRef.data.level) {
            children.push(nextElement);
            nextElement = nextElement.nextElementSibling as HTMLElement;
            nextDragRef = this.itemDragRefMap.get(nextElement);
        }

        return children;
    }

    private getTargetPosition(target: HTMLElement, event: CdkDragMove) {
        const targetRect = target.getBoundingClientRect();
        const beforeOrAfterGap = targetRect.height * 0.3;
        // 将 Item 高度分为上中下三段，其中上下的 Gap 为 height 的 30%，通过判断鼠标位置在哪一段 gap 来计算对应的位置
        if (event.pointerPosition.y - targetRect.top < beforeOrAfterGap) {
            return 'before';
        } else if (event.pointerPosition.y >= targetRect.bottom - beforeOrAfterGap) {
            return 'after';
        } else {
            return 'inside';
        }
    }

    private showDropPositionPlaceholder(targetElement: HTMLElement) {
        this.cleanupDragArtifacts();
        if (this.itemDropTarget && targetElement) {
            targetElement.classList.add(`drop-position-${this.itemDropTarget.position}`);
        }
    }

    private cleanupDragArtifacts(dropped = false) {
        if (dropped) {
            this.itemDropTarget = null;
        }
        this.document.querySelectorAll('.drop-position-before').forEach((element) => element.classList.remove('drop-position-before'));
        this.document.querySelectorAll('.drop-position-after').forEach((element) => element.classList.remove('drop-position-after'));
        this.document.querySelectorAll('.drop-position-inside').forEach((element) => element.classList.remove('drop-position-inside'));
        this.document.querySelectorAll('.drag-item-hide').forEach((element) => element.classList.remove('drop-item-hide'));
    }
}